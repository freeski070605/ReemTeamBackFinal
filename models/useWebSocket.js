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
  console.log(`📡 BROADCAST_CHECK: Broadcasting to table ${table._id} - gameOver: ${updatedState.gameOver}, gameStarted: ${updatedState.gameStarted}`);

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

const playerTimeouts = {};

const handleWebSocketConnection = async (socket, io) => {

  const resetInactivityTimeout = (socket, io) => {
    if (playerTimeouts[socket.id]) {
      clearTimeout(playerTimeouts[socket.id]);
    }

    playerTimeouts[socket.id] = setTimeout(async () => {
      console.log(`Player ${socket.userId} (socket ${socket.id}) timed out due to inactivity.`);

      // Find the table and username associated with the socket
      let playerUsername = null;
      let playerTableId = null;
      const tablesWithPlayer = await Table.find({ 'players.socketId': socket.id });
      for (const table of tablesWithPlayer) {
        const player = table.players.find(p => p.socketId === socket.id);
        if (player) {
          playerUsername = player.username;
          playerTableId = table._id;
          break;
        }
      }

      if (playerUsername && playerTableId) {
        await handlePlayerLeave({
          tableId: playerTableId,
          username: playerUsername,
          io,
          isDisconnect: true,
          assignPlayersToTables
        });
      } else {
        console.log(`Socket ${socket.id} was not found as an active player in any table.`);
      }

      delete playerTimeouts[socket.id]; // Clean up timeout
    }, 300000); // 5 minutes (increased from 30 seconds)
  };

  // CRITICAL FIX: Prevent multiple socket connections from same user
  const existingSockets = Array.from(io.sockets.sockets.values()).filter(s =>
    s !== socket && s.userId === socket.userId && s.connected
  );

  if (existingSockets.length > 0) {
    console.log(`🚫 Multiple connections detected for user ${socket.userId}. Disconnecting ${existingSockets.length} older socket(s).`);

    // Disconnect ALL older sockets for this user (not just one)
    existingSockets.forEach(oldSocket => {
      console.log(`🔌 Force disconnecting duplicate socket ${oldSocket.id} for user ${socket.userId}`);
      oldSocket.emit('force_disconnect', {
        reason: 'Another connection from this user detected',
        timestamp: Date.now()
      });
      oldSocket.disconnect(true);
    });

    // Also clean up any references to these sockets in tables
    try {
      const tablesToUpdate = await Table.find({ 'players.socketId': { $in: existingSockets.map(s => s.id) } });
      for (const table of tablesToUpdate) {
        table.players.forEach(player => {
          if (existingSockets.some(s => s.id === player.socketId)) {
            console.log(`🧹 Cleaning up stale socket reference for player ${player.username} in table ${table._id}`);
            player.socketId = null; // Clear stale socket ID
          }
        });
        await table.save();
      }
    } catch (error) {
      console.error('Error cleaning up stale socket references:', error);
    }
  }
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
  resetInactivityTimeout(socket, io);

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

 // Extracted event handlers
 const handleJoinQueue = async (data) => {
     console.log('Join queue request:', data);
     resetInactivityTimeout(socket, io);
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
 };

 // Dispatcher for unitySocketEvent
 const handleUnitySocketEvent = async (data) => {
     console.log('🔄 Backend: Received unitySocketEvent:', data);

     try {
         // Data should already be an object from Socket.IO deserialization
         let parsedData = data;

         if (!parsedData || typeof parsedData !== 'object' || !parsedData.eventName) {
             console.error('❌ Invalid unitySocketEvent structure:', parsedData);
             return;
         }

         const { eventName, data: eventData } = parsedData;
         console.log(`🎯 Backend: Dispatching unity event "${eventName}" with data:`, eventData);

         // Dispatch to appropriate handler based on event name
         switch (eventName) {
             case 'join_queue':
                 await handleJoinQueue(eventData);
                 break;
             case 'join_table':
                 await handleJoinTable(eventData);
                 break;
             case 'join_spectator':
                 await handleJoinSpectator(eventData);
                 break;
             case 'leave_queue':
                 await handleLeaveQueue(eventData);
                 break;
             case 'request_state_sync':
                 await handleRequestStateSync(eventData);
                 break;
             default:
                 console.warn(`⚠️ Unknown unity event: ${eventName}`);
         }
     } catch (error) {
         console.error('❌ Error handling unitySocketEvent:', error);
     }
 };

 socket.on('join_queue', handleJoinQueue);

 // Add handler for unitySocketEvent
 socket.on('unitySocketEvent', handleUnitySocketEvent);

 const handleJoinTable = async ({ tableId, player }) => {
      resetInactivityTimeout(socket, io);
      try {
          // Validate input data
          if (!tableId || !player || !player.username) {
              console.error('Invalid join_table data:', { tableId, player });
              socket.emit('error', { message: 'Invalid table or player data' });
              return;
          }

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

          // Verify that the socket ID is correctly associated with the player
          const playerIndex = table.players.findIndex(p => p.username === player.username);
          if (playerIndex !== -1 && table.gameState && table.gameState.players) {
            const gameStatePlayerIndex = table.gameState.players.findIndex(p => p.username === player.username);
            if (gameStatePlayerIndex !== -1) {
              table.gameState.players[gameStatePlayerIndex].socketId = socket.id;
              console.log(`✅ Verified and updated socket ID for ${player.username} in gameState`);
            }
          }

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
  };

  socket.on('join_table', handleJoinTable);
  
  

  const handleJoinSpectator = async ({ tableId }) => {
      resetInactivityTimeout(socket, io);
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
  };

  socket.on('join_spectator', handleJoinSpectator);
  

  const handleLeaveQueue = async (data) => {
      console.log('Leave queue request:', data);
      resetInactivityTimeout(socket, io);
      try {
        const { stake, username } = data;
        removeFromQueue(stake, username); // Use the new queue manager
      } catch (error) {
        console.error('Error leaving queue:', error);
        socket.emit('error', { message: 'Failed to leave queue' });
      }
  };

  socket.on('leave_queue', handleLeaveQueue);
  

  // Track state sync requests for debugging frequent sync issues
  const stateSyncTracker = new Map();

  // ✅ AUTOMATIC ERROR RECOVERY: Add state sync retry mechanism
  const stateSyncRetries = new Map();

  const handleRequestStateSync = async ({ tableId, type }) => {
    resetInactivityTimeout(socket, io);
    try {
      // Validate input
      if (!tableId) {
          console.error('❌ STATE_SYNC_ERROR: No tableId provided');
          socket.emit('error', { message: 'No table ID provided' });
          return;
      }

      // Check socket connection status
      const isConnected = socket.connected;
      const isInRoom = socket.rooms.has(tableId);
      console.log(`🔌 SOCKET_STATUS: Socket ${socket.id} connected: ${isConnected}, in room ${tableId}: ${isInRoom}`);

      // CRITICAL FIX: Ensure socket is in the table room for broadcasts
      if (!isInRoom) {
        console.log(`🔧 JOINING_ROOM: Socket ${socket.id} not in room ${tableId}, joining now...`);
        socket.join(tableId);
        console.log(`✅ ROOM_JOINED: Socket ${socket.id} successfully joined room ${tableId}`);
      }

      const table = await Table.findById(tableId);
      if (!table) {
        console.log(`❌ STATE_SYNC_ERROR: Table ${tableId} not found for socket ${socket.id}`);
        socket.emit('error', { message: 'Table not found' });
        return;
      }

      // Track sync frequency and prevent spam - limit to 1 request per second per socket
      const now = Date.now();
      const key = `${socket.id}-${tableId}`;
      const lastSync = stateSyncTracker.get(key);

      if (lastSync && now - lastSync.timestamp < 1000) {
        console.log(`🚫 STATE_SYNC_THROTTLED: Socket ${socket.id} requesting too frequently (${now - lastSync.timestamp}ms since last request)`);
        return;
      }

      const timeDiff = lastSync ? now - lastSync.timestamp : null;
      const requestCount = lastSync ? lastSync.count + 1 : 1;

      stateSyncTracker.set(key, { timestamp: now, count: requestCount });

      console.log(`📊 STATE_SYNC TRACK: Table ${tableId}, Socket ${socket.id}, Request #${requestCount}, Time since last: ${timeDiff ? timeDiff + 'ms' : 'N/A'}`);
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

        // Emit with callback to confirm delivery
        socket.emit('state_sync', table.gameState, (ack) => {
          if (ack) {
            console.log(`✅ STATE_SYNC_ACK: Socket ${socket.id} acknowledged state sync for table ${tableId}`);
          } else {
            console.log(`⚠️ STATE_SYNC_NO_ACK: Socket ${socket.id} did not acknowledge state sync for table ${tableId}`);
          }
        });
      } else {
        console.log('Backend: Emitting waiting state with players:', table.players?.map(p => ({ username: p?.username, isHuman: p?.isHuman })));

        const waitingState = {
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
        };

        socket.emit('state_sync', waitingState, (ack) => {
          if (ack) {
            console.log(`✅ WAITING_STATE_ACK: Socket ${socket.id} acknowledged waiting state for table ${tableId}`);
          } else {
            console.log(`⚠️ WAITING_STATE_NO_ACK: Socket ${socket.id} did not acknowledge waiting state for table ${tableId}`);
          }
        });
      }

      // Clean up old entries (older than 5 minutes)
      for (const [k, v] of stateSyncTracker.entries()) {
        if (now - v.timestamp > 300000) {
          stateSyncTracker.delete(k);
        }
      }
    } catch (error) {
      console.error('Error syncing state:', error);
      socket.emit('error', { message: 'Failed to sync state' });
    }
  };

  socket.on('request_state_sync', handleRequestStateSync);

  socket.on('verify_state', async ({ tableId, stateHash }) => {
      resetInactivityTimeout(socket, io);
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
    resetInactivityTimeout(socket, io);
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
  

  socket.on('game_action', async (data) => {
      console.log(`🎯 WebSocket: Received game_action event:`, data);
      resetInactivityTimeout(socket, io);

      try {
        // ✅ Critical validation: Ensure table exists and player is active
        const table = await Table.findById(data.tableId);
        if (!table) {
          console.log(`❌ game_action: Table ${data.tableId} not found`);
          socket.emit('error', { message: 'Table not found' });
          return;
        }

        // ✅ Validate player exists and is active in this table
        const playerIndex = table.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex === -1) {
          console.log(`❌ game_action: Player with socket ${socket.id} not found in table ${data.tableId}`);
          socket.emit('error', { message: 'You are not an active player at this table' });
          return;
        }

        // ✅ Validate game state exists
        if (!table.gameState) {
          console.log(`❌ game_action: No game state for table ${data.tableId}`);
          socket.emit('error', { message: 'Game not started' });
          return;
        }

        // ✅ Validate it's the correct player's turn
        if (table.gameState.players[table.gameState.currentTurn]?.socketId !== socket.id) {
          console.log(`❌ game_action: Not player's turn - current turn: ${table.gameState.currentTurn}, player socket: ${socket.id}`);
          socket.emit('error', { message: 'It is not your turn' });
          return;
        }

        // ✅ Prevent duplicate actions by checking if game is over
        if (table.gameState.gameOver) {
          console.log(`❌ game_action: Game is already over at table ${data.tableId}`);
          socket.emit('error', { message: 'Game is already over' });
          return;
        }

        handleGameAction(io, socket, data, gameStateManager); // Pass gameStateManager instance

      } catch (error) {
        console.error('❌ game_action error:', error);
        socket.emit('error', { message: 'Failed to process game action' });
      }
  });
  

  socket.on('leave_table', async ({ tableId, username }) => {
      resetInactivityTimeout(socket, io);
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

      if (playerTimeouts[socket.id]) {
        clearTimeout(playerTimeouts[socket.id]);
        delete playerTimeouts[socket.id];
      }
  
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
          isDisconnect: true, // Indicate this is a voluntary leave
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
    resetInactivityTimeout(socket, io);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });

  // Add reconnection handler
  socket.on('reconnect_player', async ({ tableId, username }) => {
     resetInactivityTimeout(socket, io);
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
