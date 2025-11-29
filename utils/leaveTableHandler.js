// utils/leaveTableHandler.js
const { Table } = require('../models/Table');
const { handleAiDeparture } = require('../models/gameLogic');

/**
 * Save table with retry logic to handle version conflicts
 */
const saveTableWithRetry = async (table, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await table.save();
      return;
    } catch (error) {
      if (error.name === 'VersionError' && attempt < maxRetries) {
        console.log(`⚠️ Version conflict on attempt ${attempt}, retrying...`);
        // Refresh the table from database
        const freshTable = await Table.findById(table._id);
        if (freshTable) {
          // Copy our changes to the fresh table
          Object.assign(freshTable, table.toObject());
          table = freshTable;
        }
        continue;
      }
      throw error;
    }
  }
};

/**
 * Enhanced player leave handler with comprehensive cleanup and state management
 */
const handlePlayerLeave = async ({ tableId, username, io = null, isDisconnect = false, assignPlayersToTables = null }) => {
  try {
    const table = await Table.findById(tableId);
    if (!table) {
      console.log(`Table ${tableId} not found - player ${username} already removed or table deleted`);
      return { success: true, message: 'Player not at table (table not found)' };
    }

    const playerIndex = table.players.findIndex(p => p.username === username);
    if (playerIndex === -1) {
      console.log(`Player ${username} not found at table ${tableId}`);
      return { success: true, message: 'Player not found at table' };
    }

    const player = table.players[playerIndex];
    const wasActiveGame = table.gameState && table.gameState.gameStarted && !table.gameState.gameOver;
    
    console.log(`🚪 Processing ${isDisconnect ? 'disconnect' : 'leave'} for ${username} at table ${tableId}`);

    // Handle different leave scenarios
    if (isDisconnect) {
      // Mark as disconnected but keep in game temporarily
      table.players[playerIndex].status = 'disconnected';
      table.players[playerIndex].socketId = null;
      table.players[playerIndex].lastActive = new Date();
      
      console.log(`📱 Player ${username} marked as disconnected`);
    } else {
      // Permanent leave - remove from table
      table.players.splice(playerIndex, 1);
      
      // Remove from ready players list
      if (table.readyPlayers) {
        table.readyPlayers = table.readyPlayers.filter(p => p !== username);
      }
      
      console.log(`👋 Player ${username} permanently left table`);
    }

    // Handle active game scenarios
    if (wasActiveGame && table.gameState) {
      const activePlayers = table.players.filter(p => p.status === 'active');
      const humanPlayers = activePlayers.filter(p => p.isHuman);
      
      // If leaving player was current turn, advance turn
      if (table.gameState.currentTurn === playerIndex && !isDisconnect) {
        table.gameState.currentTurn = table.gameState.currentTurn % table.players.length;
      }
      
      // Check if game should end
      if (activePlayers.length <= 1 || humanPlayers.length === 0) {
        await endGameDueToLeaving(table, activePlayers, username);
      } else if (!isDisconnect) {
        // Update game state to reflect removed player
        await updateGameStateAfterLeave(table, playerIndex);
        
        // ✅ Check if we need to add AI after player removal
        const remainingActivePlayers = table.players.filter(p => p.status === 'active');
        const remainingHumans = remainingActivePlayers.filter(p => p.isHuman);
        const remainingAI = remainingActivePlayers.filter(p => !p.isHuman);

        // Add AI if only 1 human left and no AI present
        if (remainingHumans.length === 1 && remainingAI.length === 0) {
          console.log(`🤖 Adding AI to replace leaving player at table ${table._id}`);
          const aiPlayer = await addAiPlayerToActiveGame(table);
          // Update game state with AI addition
          handleAiDeparture(table.gameState, 'addition', aiPlayer);
        }
      }
    }
    // Handle non-game scenarios (waiting tables)
    else if (!wasActiveGame) {
      // ✅ For waiting tables, check if we need AI companion
      const remainingActivePlayers = table.players.filter(p => p.status === 'active');
      const remainingHumans = remainingActivePlayers.filter(p => p.isHuman);
      const remainingAI = remainingActivePlayers.filter(p => !p.isHuman);

      // Add AI if only 1 human left and no AI present
      if (remainingHumans.length === 1 && remainingAI.length === 0) {
        console.log(`🤖 Adding AI companion for lone human at waiting table ${table._id}`);
        await addAiPlayerToWaitingTable(table);
      }
    }

    // Use retry logic for saving to handle version conflicts
    await saveTableWithRetry(table);

    // Broadcast updates if io is available
    if (io) {
      await broadcastTableUpdates(io, table, username, isDisconnect);
      
      // Trigger table reassignment if function is provided
      if (assignPlayersToTables) {
        await assignPlayersToTables(io);
      }
      
      // Broadcast updated tables to lobby
      const updatedTables = await Table.find();
      io.emit('tables_update', { tables: updatedTables });
    }

    return { success: true, message: `Player ${isDisconnect ? 'disconnected' : 'left'} successfully` };

  } catch (error) {
    console.error('Error in handlePlayerLeave:', error);
    throw error;
  }
};

/**
 * End game when not enough players remain
 */
const endGameDueToLeaving = async (table, activePlayers, leavingPlayer) => {
  const humanPlayers = activePlayers.filter(p => p.isHuman);
  const aiPlayers = activePlayers.filter(p => !p.isHuman);
  
  // ✅ If no humans left, remove all AI players and reset table
  if (humanPlayers.length === 0) {
    console.log(`🤖 No humans left at table ${table._id}, removing ${aiPlayers.length} AI players`);
    
    // Remove all AI players
    table.players = table.players.filter(p => p.isHuman);
    
    // Reset table to waiting state
    table.gameState = null;
    table.status = 'waiting';
    table.readyPlayers = [];
    
    console.log(`🧹 Table ${table._id} reset to waiting state - no AI-only games`);
    return;
  }
  
  if (activePlayers.length > 0) {
    const winnerIndex = table.players.findIndex(p => p.status === 'active');
    if (winnerIndex !== -1) {
      table.gameState.gameOver = true;
      table.gameState.winners = [winnerIndex];
      table.gameState.winType = 'FORFEIT_WIN';
      table.gameState.message = `Game ended - ${leavingPlayer} left the table`;
    }
  } else {
    // No active players left
    table.gameState.gameOver = true;
    table.gameState.winners = [];
    table.gameState.winType = 'ABANDONED';
    table.gameState.message = 'Game abandoned - all players left';
  }
  
  table.status = 'completed';
  console.log(`🏁 Game ended at table ${table._id} due to player leaving`);
};

/**
 * Update game state arrays after a player permanently leaves
 */
const updateGameStateAfterLeave = async (table, removedPlayerIndex) => {
  const gameState = table.gameState;
  
  // Remove player's hand and spreads
  if (gameState.playerHands && gameState.playerHands[removedPlayerIndex]) {
    gameState.playerHands.splice(removedPlayerIndex, 1);
  }
  
  if (gameState.playerSpreads && gameState.playerSpreads[removedPlayerIndex]) {
    gameState.playerSpreads.splice(removedPlayerIndex, 1);
  }
  
  // Update current turn if necessary
  if (gameState.currentTurn >= removedPlayerIndex) {
    gameState.currentTurn = Math.max(0, gameState.currentTurn - 1);
  }
  
  // Ensure current turn is within bounds
  if (gameState.currentTurn >= table.players.length) {
    gameState.currentTurn = 0;
  }
  
  // Update players array in game state
  gameState.players = table.players.map(p => ({
    username: p.username,
    chips: p.chips,
    isHuman: p.isHuman,
    socketId: p.socketId,
    status: p.status,
    hitCount: p.hitCount || 0,
    hitPenaltyRounds: p.hitPenaltyRounds || 0
  }));
  
  console.log(`🔄 Updated game state after player removal`);
};

/**
 * Broadcast all necessary updates to clients
 */
const broadcastTableUpdates = async (io, table, username, isDisconnect) => {
  const tableId = table._id.toString();
  
  // Broadcast player list update
  io.to(tableId).emit('table_players_update', {
    players: table.players,
    spectators: table.spectators || [],
    readyPlayers: table.readyPlayers || []
  });
  
  // Broadcast game state if game is active
  if (table.gameState) {
    io.to(tableId).emit('state_sync', table.gameState);
  }
  
  // Broadcast leave event
  io.to(tableId).emit('player_left', {
    tableId: tableId,
    username: username,
    players: table.players,
    isDisconnect: isDisconnect
  });
  
  // Broadcast game event if game ended
  if (table.gameState && table.gameState.gameOver) {
    io.to(tableId).emit('game_event', {
      type: 'game_forfeit',
      message: table.gameState.message || 'Game ended due to player leaving'
    });
  }
  
  console.log(`📡 Broadcasted updates for ${username} ${isDisconnect ? 'disconnect' : 'leave'}`);
};

/**
 * Handle player reconnection
 */
const handlePlayerReconnect = async ({ tableId, username, socketId, io = null }) => {
  try {
    const table = await Table.findById(tableId);
    if (!table) {
      throw new Error('Table not found');
    }

    const playerIndex = table.players.findIndex(p => p.username === username);
    if (playerIndex === -1) {
      throw new Error('Player not found at table');
    }

    const player = table.players[playerIndex];
    
    // Check if player is already active
    if (player.status === 'active') {
      console.log(`🔄 Player ${username} is already active at table ${tableId}, no reconnection needed`);
      
      // Still send current game state to ensure sync
      if (io && table.gameState) {
        io.to(socketId).emit('state_sync', table.gameState);
      }
      
      return { success: true, message: 'Player already active' };
    }
    
    if (player.status === 'disconnected') {
      // Disconnect any existing sockets for this user at this table
      if (io) {
        for (const s of io.sockets.sockets.values()) {
          if (s.userId === player.username && s.id !== socketId) {
            console.log(`🔌 Disconnecting old socket ${s.id} for user ${username} at table ${tableId}`);
            s.disconnect(true);
          }
        }
      }

      // Reconnect the player
      player.status = 'active';
      player.socketId = socketId;
      player.lastActive = new Date();
      
      await saveTableWithRetry(table);
      
      // Update socketId in gameState.players as well
      if (table.gameState && table.gameState.players) {
        const gameStatePlayerIndex = table.gameState.players.findIndex(p => p.username === username);
        if (gameStatePlayerIndex !== -1) {
          table.gameState.players[gameStatePlayerIndex].socketId = socketId;
          console.log(`🎯 Updated gameState.players[${gameStatePlayerIndex}].socketId to ${socketId}`);
        }
      }

      console.log(`🔄 Player ${username} reconnected to table ${tableId} with new socket ID: ${socketId}`);
      
      if (io) {
        // Broadcast reconnection to all players at the table
        io.to(tableId).emit('player_reconnected', {
          username: username,
          players: table.players.map(p => ({
            username: p.username,
            isHuman: p.isHuman,
            status: p.status
          })) // Send simplified player info
        });
        
        // Send current game state to the reconnected player only
        if (table.gameState) {
          console.log(`Sending state_sync to reconnected player ${username} (socket ${socketId})`);
          io.to(socketId).emit('state_sync', table.gameState);
        } else {
          // If no game state, send waiting state
          io.to(socketId).emit('state_sync', {
            players: table.players,
            stake: table.stake,
            message: 'Waiting for players to be ready...',
            gameStarted: false,
            playerHands: [],
            playerSpreads: [],
            deck: [],
            discardPile: [],
            currentTurn: 0,
            gameOver: false,
            readyPlayers: table.readyPlayers || [],
            isInitialized: true,
            isLoading: false,
            timestamp: Date.now()
          });
        }
      }
      
      return { success: true, message: 'Player reconnected successfully' };
    }
    
    return { success: false, message: 'Player was not disconnected' };
    
  } catch (error) {
    console.error('Error in handlePlayerReconnect:', error);
    throw error;
  }
};

/**
 * Clean up disconnected players who have been offline too long
 */
const cleanupDisconnectedPlayers = async (io, timeoutMinutes = 5, assignPlayersToTables = null) => {
  try {
    const cutoffTime = new Date();
    cutoffTime.setMinutes(cutoffTime.getMinutes() - timeoutMinutes);
    
    const tables = await Table.find({
      'players.status': 'disconnected',
      'players.lastActive': { $lt: cutoffTime }
    });
    
    for (const table of tables) {
      const disconnectedPlayers = table.players.filter(
        p => p.status === 'disconnected' && p.lastActive < cutoffTime
      );
      
      for (const player of disconnectedPlayers) {
        console.log(`🧹 Cleaning up disconnected player ${player.username} from table ${table._id}`);
        await handlePlayerLeave({
          tableId: table._id,
          username: player.username,
          io: io,
          isDisconnect: false, // Treat as permanent leave
          assignPlayersToTables: assignPlayersToTables
        });
      }
    }
    
    console.log(`🧹 Cleanup completed for ${tables.length} tables`);
    
  } catch (error) {
    console.error('Error in cleanupDisconnectedPlayers:', error);
  }
};

/**
 * Clean up empty tables - BUT NEVER DELETE PRESET TABLES
 */
const cleanupEmptyTables = async (io) => {
  try {
    // Only clean up dynamically created tables, never preset tables
    // Preset tables should always remain available for players to join
    const emptyTables = await Table.find({
      $and: [
        {
          $or: [
            { players: { $size: 0 } },
            { 'players.status': { $nin: ['active', 'disconnected'] } }
          ]
        },
        // Only delete tables that are NOT preset tables (have a tableId starting with 'table-')
        { tableId: { $not: /^table-/ } }
      ]
    });
    
    for (const table of emptyTables) {
      const activePlayers = table.players.filter(p => p.status === 'active' || p.status === 'disconnected');
      
      if (activePlayers.length === 0) {
        console.log(`🗑️ Deleting empty dynamically created table ${table._id}`);
        await Table.findByIdAndDelete(table._id);
      }
    }
    
    // Reset empty preset tables to clean state instead of deleting them
    const emptyPresetTables = await Table.find({
      $and: [
        { players: { $size: 0 } },
        { tableId: /^table-/ } // Preset tables
      ]
    });
    
    for (const table of emptyPresetTables) {
      // Reset table to clean state but keep it
      table.gameState = null;
      table.status = 'waiting';
      table.readyPlayers = [];
      table.spectators = [];
      await saveTableWithRetry(table);
      console.log(`🧹 Reset empty preset table ${table.tableId} to clean state`);
    }
    
    if ((emptyTables.length > 0 || emptyPresetTables.length > 0) && io) {
      const updatedTables = await Table.find();
      io.emit('tables_update', { tables: updatedTables });
    }
    
  } catch (error) {
    console.error('Error in cleanupEmptyTables:', error);
  }
};

/**
 * Add AI player to an active game
 */
const addAiPlayerToActiveGame = async (table) => {
  const aiPlayerName = `AI Player ${table._id.toString().slice(-4)}`;

  const aiPlayer = {
    username: aiPlayerName,
    chips: 1000,
    isHuman: false,
    socketId: null,
    joinedAt: new Date(),
    status: 'active'
  };

  table.players.push(aiPlayer);

  console.log(`🤖 Added AI player ${aiPlayerName} to active game at table ${table._id}`);

  await saveTableWithRetry(table);

  return aiPlayer;
};

/**
 * Add AI player to a waiting table
 */
const addAiPlayerToWaitingTable = async (table) => {
  const aiPlayerName = `AI Player ${table._id.toString().slice(-4)}`;
  
  const aiPlayer = {
    username: aiPlayerName,
    chips: 1000,
    isHuman: false,
    socketId: null,
    joinedAt: new Date(),
    status: 'active'
  };
  
  table.players.push(aiPlayer);
  await saveTableWithRetry(table);
  
  console.log(`🤖 Added AI companion ${aiPlayerName} to waiting table ${table._id}`);
};

module.exports = {
  handlePlayerLeave,
  handlePlayerReconnect,
  cleanupDisconnectedPlayers,
  cleanupEmptyTables,
  addAiPlayerToActiveGame,
  addAiPlayerToWaitingTable
};
