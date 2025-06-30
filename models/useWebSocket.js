const { Table, PRESET_TABLES } = require('../models/Table');
const {
  createDeck,
  shuffleDeck,
  dealHands,
  calculateStateHash,
  findBestSpread,
  calculatePoints,
  processGameAction
} = require('./gameLogic');
const {
  initializeQueues,
  addToQueue,
  removeFromQueue,
  getQueues,
  setQueueLock,
  isQueueLocked
} = require('../utils/smartQueueManager');
const { handleGameAction } = require('../routes/gameActions');
const { runAiTurn } = require('./AiPlayer');
const {
  handlePlayerLeave,
  handlePlayerReconnect,
  cleanupDisconnectedPlayers,
  cleanupEmptyTables
} = require('../utils/leaveTableHandler');
const EnhancedMatchmaking = require('../utils/enhancedMatchmaking');
const GameStateManager = require('../utils/gameStateManager');

// Initialize enhanced systems
initializeQueues(PRESET_TABLES.map(t => t.stake));
let enhancedMatchmaking = null;
let gameStateManager = null;


// Create initial deck constant
const initialDeck = createDeck();


// --- Central helper to broadcast game state ---
const broadcastGameState = (io, table) => {
  if (!table || !table.gameState) return;

  const updatedState = { ...table.gameState };
  
  updatedState.isInitialized = true;
  updatedState.isLoading = false;

  console.log('Backend: Broadcasting game_update. Players:', updatedState.players?.map(p => ({ username: p?.username, isHuman: p?.isHuman })));


  io.to(table._id).emit('game_update', table.gameState);
};



const handleAiTurn = async (tableId, io) => {
  // Use enhanced game state manager for AI turns
  if (gameStateManager) {
    await gameStateManager.handleAiTurn(tableId);
  } else {
    // Fallback to original implementation
    try {
      const table = await Table.findById(tableId);
      if (!table || !table.gameState) return;

      const updatedState = runAiTurn(table.gameState);

      table.gameState = updatedState;
      await table.save();
      updatedState.isInitialized = true;
      updatedState.isLoading = false;

      io.to(tableId).emit('game_update', updatedState);

      if (!updatedState.gameOver) {
        const nextPlayer = updatedState.players[updatedState.currentTurn];
        if (!nextPlayer.isHuman) {
          setTimeout(() => handleAiTurn(tableId, io), 800);
        }
      }
    } catch (error) {
      console.error('AI turn error:', error);
    }
  }
};



// Enhanced matchmaking with seamless AI-to-human transitions
const assignPlayersToTables = async (io) => {
  if (!enhancedMatchmaking) {
    enhancedMatchmaking = new EnhancedMatchmaking(io);
  }
  
  await enhancedMatchmaking.assignPlayersToTables();
};


// Remove duplicate handlePlayerLeave function - now using the optimized version from leaveTableHandler.js





const jwt = require('jsonwebtoken');

const handleWebSocketConnection = (socket, io) => {
  // --- AUTHENTICATION MIDDLEWARE ---
  const { token, userId } = socket.handshake.query || {};
  const JWT_SECRET = process.env.JWT_SECRET || 'reemteamsecret';

  if (!token || !userId) {
    console.log('Socket connection rejected: missing token or userId');
    socket.disconnect(true);
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.userId !== userId) {
      console.log('Socket connection rejected: userId mismatch');
      socket.disconnect(true);
      return;
    }
    // Attach userId to socket for later use
    socket.userId = userId;
  } catch (err) {
    console.log('Socket connection rejected: invalid token');
    socket.disconnect(true);
    return;
  }

  console.log('WebSocket connected with ID:', socket.id, 'for user:', userId);

  // Initialize enhanced systems if not already done
  if (!enhancedMatchmaking) {
    enhancedMatchmaking = new EnhancedMatchmaking(io);
  }
  if (!gameStateManager) {
    gameStateManager = new GameStateManager(io);
  }

  // Track player's active tables
  const playerTables = new Set();

  socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
  });

  socket.on('disconnecting', (reason) => {
    console.log(`Socket ${socket.id} is disconnecting. Reason: ${reason}`);
    // Iterate over all rooms the socket is in, except its own ID room
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        console.log(`Socket ${socket.id} leaving room: ${room}`);
        // You could emit a 'player_leaving_room' event here if needed
        // io.to(room).emit('player_leaving_room', { socketId: socket.id, reason });
      }
    }
  });

  socket.on('connect', async () => {
    console.log('Client connected successfully');
    // Send initial tables list and enhanced queue status
    const tables = await Table.find();
    const { getAllQueueStatus } = require('../utils/smartQueueManager');
    const queueStatus = getAllQueueStatus();
    
    io.emit('tables_update', { tables });
    socket.emit('queue_status_full', queueStatus);
  });

 // Improved join queue handler
socket.on('join_queue', async (data) => {
    console.log('Join queue request:', data);
    try {
        const { stake, player } = data;
        const playerData = {
            username: player.username,
            chips: player.chips,
            isHuman: true,
            socketId: socket.id,
            joinedAt: new Date()
        };
        addToQueue(stake, playerData); // Use the new queue manager
        const queues = getQueues();
        const queue = queues.get(stake);
        const position = queue.findIndex(p => p.username === player.username) + 1;
        socket.emit('queue_status', {
            stake,
            position,
            queueSize: queue.length,
            estimatedWait: Math.max(0, (position - 1) * 10)
        });
        setImmediate(() => assignPlayersToTables(io));
    } catch (error) {
        console.error('Error joining queue:', error);
        socket.emit('error', { message: 'Failed to join queue' });
    }
});

socket.on('join_table', async ({ tableId, player }) => {
    try {
        // Check if player is already at this table to prevent duplicates
        const existingTable = await Table.findById(tableId);
        if (existingTable && existingTable.players.some(p => p.username === player.username)) {
            console.log(`Player ${player.username} already at table ${tableId}, skipping join`);
            socket.join(tableId);
            socket.emit('you_are_seated', {
                tableId: tableId,
                message: 'You are already at this table!'
            });
            return;
        }

        // Use enhanced game state manager for seamless mid-game joins
        const newPlayerData = {
            username: player.username,
            chips: player.chips,
            isHuman: true,
            socketId: socket.id,
            joinedAt: new Date(),
            status: 'active'
        };

        const joinResult = await gameStateManager.handleMidGameJoin(tableId, newPlayerData);

        // --- CRITICAL FIX: Always join the socket room for the table, even if spectating ---
        socket.join(tableId);

        if (joinResult.mode === 'spectating') {
            // Player is spectating until hand completes
            socket.emit('spectator_mode_active', {
                message: joinResult.message || 'Watching current hand - you\'ll join when it completes',
                transitionId: joinResult.transitionId,
                tableId: tableId
            });
            // --- NEW: Ensure spectator receives all live game updates by being in the room ---
            // No further action needed; joining the room above ensures this.
        } else if (joinResult.mode === 'spectating_until_next_hand') {
            // Table is full, spectating until next hand
            socket.emit('spectator_mode_active', {
                message: 'Table is full - you\'ll join the next hand',
                willJoinNextHand: true,
                tableId: tableId
            });
        } else {
            // Normal player join
            socket.emit('you_are_seated', {
                tableId: tableId,
                message: joinResult.message || 'Welcome to the table!'
            });
        }

        // Get updated table state
        const table = await Table.findById(tableId);
        
        // Send appropriate game state - always send current table state
        if (table.gameState && table.gameState.gameStarted && !table.gameState.gameOver) {
            // --- NEW: Spectators should also receive state_sync for live watching ---
            console.log('Sending active game state to player/spectator:', table.gameState.players?.map(p => p.username));
            socket.emit('state_sync', table.gameState);
        } else {
            // Game not started, send waiting state with current players
            console.log('Sending waiting state with players:', table.players?.map(p => p.username));
            socket.emit('state_sync', {
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

        // Broadcast updates
        io.emit('tables_update', { tables: await Table.find() });
        io.to(tableId).emit('table_players_update', {
            players: table.players,
            spectators: table.spectators || [],
            readyPlayers: table.readyPlayers || [],
            transitionStatus: gameStateManager.getTransitionStatus(tableId)
        });

    } catch (error) {
        console.error('Error in enhanced join_table:', error);
        socket.emit('error', { message: 'Failed to join table' });
    }
});
  
  

  socket.on('join_spectator', async ({ tableId }) => {
    const table = await Table.findById(tableId);
    if (!table) return;
  
    // Join the room
    socket.join(tableId);
  
    // Add spectator to tracking list if not present
    if (!table.spectators.some(s => s.socketId === socket.id)) {
      table.spectators.push({
        username: socket.username || 'Guest',
        socketId: socket.id,
        joinedAt: new Date()
      });
      await table.save();
    }
  
    const hasStarted = table?.gameState?.playerHands?.length > 0;
  
    if (hasStarted) {
      console.log(`Spectator joined in-progress game at table ${tableId}`);
      socket.emit('state_sync', {
        ...table.gameState,
        gameStarted: true
      });
    } else {
      console.log(`Spectator joined pre-game table ${tableId}`);
      socket.emit('state_sync', {
        players: table.players,
        stake: table.stake,
        message: 'Game has not started yet. Waiting for next hand...',
        gameStarted: false,
        playerHands: [],
        playerSpreads: [],
        deck: [],
        discardPile: [],
        currentTurn: 0,
        gameOver: false
      });
    }
  });
  
  

  // Add a leave_queue event
  socket.on('leave_queue', async (data) => {
      console.log('Leave queue request:', data);
      try {
          const { stake, username } = data;
          removeFromQueue(stake, username); // Use the new queue manager
      } catch (error) {
          console.error('Error leaving queue:', error);
          socket.emit('error', { message: 'Failed to leave queue' });
      }
  });
  

  socket.on('request_state_sync', async ({ tableId }) => {
    try {
      const table = await Table.findById(tableId);
      if (!table) {
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      console.log('Backend: State sync requested for table:', tableId);
      console.log('Backend: Table players:', table.players?.map(p => ({ username: p?.username, isHuman: p?.isHuman })));
      
      if (table.gameState) {
        console.log('🔍 STATE_SYNC: Database game state details:', {
          gameStarted: table.gameState.gameStarted,
          gameOver: table.gameState.gameOver,
          winType: table.gameState.winType,
          winners: table.gameState.winners,
          timestamp: table.gameState.timestamp,
          currentTurn: table.gameState.currentTurn
        });
        console.log('Backend: Emitting game state. Players:', table.gameState.players?.map(p => ({ username: p?.username, isHuman: p?.isHuman })));
        socket.emit('state_sync', table.gameState);
      } else {
        console.log('Backend: Emitting waiting state with players:', table.players?.map(p => ({ username: p?.username, isHuman: p?.isHuman })));
        socket.emit('state_sync', {
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
    } catch (error) {
      console.error('Error syncing state:', error);
      socket.emit('error', { message: 'Failed to sync state' });
    }
  });

  socket.on('verify_state', async ({ tableId, stateHash }) => {
    try {
      const table = await Table.findById(tableId);
      if (!table || !table.gameState) return;
  
      const serverStateHash = calculateStateHash(table.gameState);
  
      if (stateHash !== serverStateHash) {
        socket.emit('state_verification_failed');
      }
    } catch (error) {
      console.error('Error verifying state:', error);
    }
  });
  



  socket.on('player_ready', async ({ tableId, username, autoReady = false }) => {
    console.log(`🔍 WebSocket: Received player_ready event for ${username} at table ${tableId} (autoReady: ${autoReady})`);
    try {
      // Use enhanced game state manager for ready-up handling
      console.log(`🔍 WebSocket: Calling gameStateManager.handlePlayerReady for ${username}`);
      await gameStateManager.handlePlayerReady(tableId, username, { autoReady });
      console.log(`🔍 WebSocket: handlePlayerReady completed for ${username}`);
      
      // Check for pending transitions after ready-up
      await gameStateManager.checkPendingTransitions();
      
    } catch (err) {
      console.error('Enhanced player_ready error:', err);
      socket.emit('error', { message: 'An error occurred while getting ready.' });
    }
  });
  
  

  socket.on('game_action', (data) => {
      console.log(`🎯 WebSocket: Received game_action event:`, data);
      handleGameAction(io, socket, data, gameStateManager); // Pass gameStateManager instance
  });
  

  socket.on('leave_table', async ({ tableId, username }) => {
    try {
      await handlePlayerLeave({
        tableId,
        username,
        io,
        isDisconnect: false,
        assignPlayersToTables
      });
    } catch (err) {
      console.error('leave_table error:', err);
      socket.emit('error', { message: 'Failed to leave table' });
    }
  });
  
   

  socket.on('disconnect', async (reason) => {
    try {
      console.log(`Client disconnected: ${socket.id}, Reason: ${reason}`);
  
      let playerUsername = null;
      let playerTableId = null;

      // Find if the disconnected socket was associated with a player in any table
      const tablesWithPlayer = await Table.find({ 'players.socketId': socket.id });
      for (const table of tablesWithPlayer) {
        const player = table.players.find(p => p.socketId === socket.id);
        if (player) {
          playerUsername = player.username;
          playerTableId = table._id;
          console.log(`Player ${playerUsername} (socket ${socket.id}) disconnected from table ${playerTableId}`);
          break; // Found the player, no need to check other tables
        }
      }

      // Remove from queues if the player was in a queue
      getQueues().forEach((queue, stake) => {
          const playerInQueue = queue.find(p => p.socketId === socket.id);
          if (playerInQueue) {
              removeFromQueue(stake, playerInQueue.username);
              console.log(`Player ${playerInQueue.username} removed from queue $${stake} due to disconnect.`);
          }
      });
  
      // Handle disconnection from tables using the optimized handler
      if (playerUsername && playerTableId) {
        await handlePlayerLeave({
          tableId: playerTableId,
          username: playerUsername,
          io,
          isDisconnect: true, // Indicate this is a disconnect, not a voluntary leave
          assignPlayersToTables
        });
      } else {
        console.log(`Disconnected socket ${socket.id} was not found as an active player in any table.`);
      }
  
      // Trigger table reassignment after disconnect to fill empty spots
      await assignPlayersToTables(io);
  
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
  

  // Add heartbeat mechanism
  const heartbeatInterval = setInterval(() => {
    socket.emit('ping');
  }, process.env.SOCKET_PING_INTERVAL || 30000);

  socket.on('pong', () => {
    // Client is still connected
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  // Add reconnection handler
  socket.on('reconnect_player', async ({ tableId, username }) => {
    try {
      const result = await handlePlayerReconnect({
        tableId,
        username,
        socketId: socket.id,
        io
      });
      
      if (result.success) {
        socket.join(tableId);
        socket.emit('reconnect_success', { message: result.message });
      } else {
        socket.emit('reconnect_failed', { message: result.message });
      }
    } catch (error) {
      console.error('Error handling reconnection:', error);
      socket.emit('reconnect_failed', { message: 'Failed to reconnect' });
    }
  });

  // Clean up on disconnect
};



module.exports = { 
  handleWebSocketConnection,
  assignPlayersToTables,
  broadcastGameState
};
