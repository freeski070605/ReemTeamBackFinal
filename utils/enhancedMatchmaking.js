const { Table } = require('../models/Table');
const { runAiTurn } = require('../models/AiPlayer');
const User = require('../models/User'); // Import User model
const {
  initializeQueues,
  addToQueue,
  removeFromQueue,
  getQueues,
  setQueueLock,
  isQueueLocked
} = require('./smartQueueManager');

/**
 * Enhanced Matchmaking System
 * Provides seamless AI-to-human transitions with production-ready features
 */

const GameStateManager = require('../utils/gameStateManager');
let gameStateManagerSingleton = null;

class EnhancedMatchmaking {
  constructor(io) {
    this.io = io;
    this.pendingTransitions = new Map(); // Track tables with pending AI transitions
    this.spectatorQueues = new Map(); // Track spectators waiting for next hand
    // Ensure singleton gameStateManager for cross-system transition sync
    if (!gameStateManagerSingleton) {
      gameStateManagerSingleton = new GameStateManager(io);
    }
  }

  /**
   * Main matchmaking function with priority-based assignment
   * ONLY works with existing tables - never creates or deletes them
   */
  async assignPlayersToTables() {
    try {
      // Only work with existing tables, sorted by stake and player count
      const tables = await Table.find({}).sort({ stake: 1, 'players.length': 1 });

      // ✅ Process each stake level separately to ensure proper queue handling
      const stakeGroups = new Map();
      tables.forEach(table => {
        if (!stakeGroups.has(table.stake)) {
          stakeGroups.set(table.stake, []);
        }
        stakeGroups.get(table.stake).push(table);
      });

      // Process each stake level
      for (const [stake, stakeTables] of stakeGroups) {
        if (isQueueLocked(stake)) continue;
        setQueueLock(stake, true);

        try {
          // ✅ Process tables in order: active games first, then waiting tables
          const activeTables = stakeTables.filter(t => t.gameState && t.gameState.gameStarted && !t.gameState.gameOver);
          const waitingTables = stakeTables.filter(t => !t.gameState || !t.gameState.gameStarted || t.gameState.gameOver);
          
          // Process active tables first (for graceful transitions)
          for (const table of activeTables) {
            await this.processTableAssignment(table);
          }
          
          // Then process waiting tables
          for (const table of waitingTables) {
            await this.processTableAssignment(table);
          }
          
        } finally {
          setQueueLock(stake, false);
        }
      }

      // ✅ After processing existing tables, check if we need to create new ones
      await this.handleQueueOverflow();

      // Broadcast comprehensive lobby update
      const updatedTables = await Table.find();
      this.io.emit('tables_update', {
        tables: updatedTables,
        timestamp: Date.now(),
        message: 'Tables updated'
      });

    } catch (err) {
      console.error('Enhanced matchmaking error:', err);
      getQueues().forEach((_, stake) => setQueueLock(stake, false));
    }
  }

  /**
   * Process assignment for a specific table with intelligent AI management
   */
  async processTableAssignment(table) {
    const queues = getQueues();
    const queue = queues.get(table.stake) || [];
    let tableModified = false;

    const humanCount = table.players.filter(p => p.isHuman && p.status === 'active').length;
    const aiCount = table.players.filter(p => !p.isHuman && p.status === 'active').length;
    const gameIsActive = table.gameState && table.gameState.gameStarted && !table.gameState.gameOver;
    const isInTransition = this.pendingTransitions.has(table._id.toString());

    // Priority 1: Handle pending transitions (human joining active AI game)
    if (isInTransition) {
      await this.handlePendingTransition(table);
      return;
    }

    // Priority 2: Fill tables with waiting human players
    while (table.players.length < 4 && queue.length > 0) {
      const player = queue.shift();
      
      if (!table.players.some(p => p.username === player.username)) {
        if (gameIsActive && aiCount > 0) {
          // Human joining active AI game - initiate graceful transition
          await this.initiateGracefulTransition(table, player);
          // ✅ CRITICAL FIX: Remove player from queue after transition setup
          const queues = getQueues();
          const stakeQueue = queues.get(table.stake) || [];
          const playerIndex = stakeQueue.findIndex(p => p.username === player.username);
          if (playerIndex !== -1) {
            stakeQueue.splice(playerIndex, 1);
          }
        } else {
          // Standard join
          await this.addPlayerToTable(table, player);
        }
        tableModified = true;
      }
    }

    // Priority 3: Smart AI management
    if (humanCount === 1 && aiCount === 0 && table.players.length < 4 && !gameIsActive) {
      await this.addAiPlayer(table);
      tableModified = true;
      
      // Auto-start game when human + AI are ready
      await this.checkAndStartGame(table);
    }

    // Priority 4: Remove excess AI when humans are available
    if (humanCount >= 2 && aiCount > 1) {
      await this.removeExcessAi(table);
      tableModified = true;
    }

    if (tableModified) {
      await table.save();
      await this.broadcastTableUpdates(table);
    }
  }

  /**
   * Initiate graceful transition when human joins active AI game
   */
  async initiateGracefulTransition(table, newPlayer) {
    console.log(`🔄 Initiating graceful transition for ${newPlayer.username} joining active game at table ${table._id}`);

    // Add player as spectator first
    if (!table.spectators) table.spectators = [];
    table.spectators.push({
      username: newPlayer.username,
      socketId: newPlayer.socketId,
      joinedAt: new Date(),
      chips: newPlayer.chips,
      isHuman: true,
      pendingPlayer: true // Mark as pending player
    });

    // Mark table for transition
    this.pendingTransitions.set(table._id.toString(), {
      newPlayer,
      transitionStarted: Date.now(),
      currentHandMustComplete: true
    });

    // --- Also register transition in GameStateManager for cross-system sync ---
    if (gameStateManagerSingleton && typeof gameStateManagerSingleton.registerTransitionFromMatchmaking === 'function') {
      gameStateManagerSingleton.registerTransitionFromMatchmaking(table, newPlayer);
    }

    // Notify all players about incoming transition
    this.io.to(table._id).emit('transition_initiated', {
      message: `${newPlayer.username} is joining after this hand completes`,
      newPlayerName: newPlayer.username,
      estimatedTime: this.estimateHandCompletionTime(table.gameState)
    });

    // Notify the joining player they're spectating until hand completes
    this.io.to(newPlayer.socketId).emit('spectator_mode', {
      tableId: table._id,
      message: 'Watching current hand - you\'ll join when it completes',
      gameState: this.createSpectatorGameState(table.gameState),
      position: 'pending'
    });

    // --- CRITICAL: Also emit spectator_mode_active for frontend navigation compatibility ---
    this.io.to(newPlayer.socketId).emit('spectator_mode_active', {
      tableId: table._id.toString(),
      message: 'Watching current hand - you\'ll join when it completes',
      transitionId: this.pendingTransitions.get(table._id.toString())?.transitionId || null,
      gameState: this.createSpectatorGameState(table.gameState)
    });

    console.log(`👁️ ${newPlayer.username} added as spectator, will join after current hand`);
  }

  /**
   * Handle completion of pending transition
   */
  async handlePendingTransition(table) {
    const transition = this.pendingTransitions.get(table._id.toString());
    if (!transition) return;

    const gameState = table.gameState;
    
    // Check if current hand is complete
    if (!gameState || gameState.gameOver || !gameState.gameStarted) {
      console.log(`✅ Hand completed, executing transition for table ${table._id}`);
      
      // Move spectator to player
      const pendingSpectator = table.spectators.find(s => s.pendingPlayer);
      if (pendingSpectator) {
        // Remove from spectators
        table.spectators = table.spectators.filter(s => !s.pendingPlayer);
        
        // Add as player
        table.players.push({
          username: pendingSpectator.username,
          chips: pendingSpectator.chips,
          isHuman: true,
          socketId: pendingSpectator.socketId,
          joinedAt: new Date(),
          status: 'active'
        });

        // Remove AI players
        const aiPlayers = table.players.filter(p => !p.isHuman);
        table.players = table.players.filter(p => p.isHuman);

        // Reset game state for new hand
        table.gameState = null;
        table.status = 'waiting';
        table.readyPlayers = [];

        // Clear transition
        this.pendingTransitions.delete(table._id.toString());

        // Notify all players
        this.io.to(table._id).emit('transition_completed', {
          message: `${pendingSpectator.username} has joined the table`,
          newPlayer: pendingSpectator.username,
          removedAI: aiPlayers.map(ai => ai.username),
          readyForNewHand: true
        });

        // Notify the new player they can now play
        this.io.to(pendingSpectator.socketId).emit('player_mode_activated', {
          tableId: table._id,
          message: 'You can now play! Get ready for the next hand.',
          seatPosition: table.players.length - 1
        });

        console.log(`🎉 Transition completed: ${pendingSpectator.username} is now a player`);
      }
    }
  }

  /**
   * Add player to table with enhanced notifications
   */
  async addPlayerToTable(table, player) {
    table.players.push({
      username: player.username,
      chips: player.chips,
      isHuman: true,
      socketId: player.socketId,
      joinedAt: new Date(),
      status: 'active'
    });

    // Enhanced notification with seat assignment
    this.io.to(player.socketId).emit('table_assigned', {
      tableId: table._id,
      seat: table.players.length - 1,
      stake: table.stake,
      playerCount: table.players.length,
      message: `Joined $${table.stake} table`,
      gameStatus: table.gameState ? 'in_progress' : 'waiting',
      canPlayImmediately: !table.gameState
    });

    console.log(`✅ ${player.username} assigned to $${table.stake} table ${table._id}`);
  }

  /**
   * Add AI player with smart naming
   */
  async addAiPlayer(table) {
    const tableIdStr = table._id.toString();
    const aiName = `AI Player ${tableIdStr.slice(-4)}`;
    
    table.players.push({
      username: aiName,
      chips: 1000000,
      isHuman: false,
      socketId: null,
      joinedAt: new Date(),
      status: 'active'
    });

    console.log(`🤖 Added AI companion (${aiName}) to $${table.stake} table for immediate play`);
    
    // Broadcast updated player list immediately after adding AI
    this.io.to(table._id).emit('table_players_update', {
      players: table.players,
      spectators: table.spectators || [],
      readyPlayers: table.readyPlayers || []
    });
  }

  /**
   * Remove excess AI players intelligently
   */
  async removeExcessAi(table) {
    const aiPlayers = table.players.filter(p => !p.isHuman);
    const excessAI = aiPlayers.slice(1); // Keep one AI, remove others
    
    table.players = table.players.filter(p => p.isHuman || aiPlayers.indexOf(p) === 0);
    
    console.log(`🧹 Removed ${excessAI.length} excess AI player(s) from table ${table._id}`);
  }

  /**
   * Create spectator-safe game state
   */
  createSpectatorGameState(gameState) {
    if (!gameState) return null;

    return {
      ...gameState,
      playerHands: gameState.playerHands.map(hand => 
        hand.map(() => ({ rank: 'hidden', suit: 'hidden' }))
      ), // Hide all hands for spectators
      deck: [], // Hide deck
      spectatorMode: true,
      message: 'Spectating current hand'
    };
  }

  /**
   * Estimate how long current hand will take to complete
   */
  estimateHandCompletionTime(gameState) {
    if (!gameState || gameState.gameOver) return 0;
    
    const remainingTurns = gameState.players.length * 2; // Rough estimate
    const avgTurnTime = 15; // seconds
    return remainingTurns * avgTurnTime;
  }

  /**
   * Broadcast comprehensive table updates
   */
  async broadcastTableUpdates(table) {
    const humanCount = table.players.filter(p => p.isHuman && p.status === 'active').length;
    
    // Update table players
    this.io.to(table._id).emit('table_players_update', {
      players: table.players,
      spectators: table.spectators || [],
      readyPlayers: table.readyPlayers || [],
      stake: table.stake,
      status: table.status,
      pendingTransition: this.pendingTransitions.has(table._id.toString())
    });

    // Update lobby
    this.io.emit('table_status_update', {
      tableId: table._id,
      playerCount: table.players.length,
      humanCount: humanCount,
      status: table.status,
      stake: table.stake,
      hasSpectators: (table.spectators || []).length > 0
    });
  }

  /**
   * Handle game end with transition check
   */
  async handleGameEnd(tableId) {
    const table = await Table.findById(tableId);
    if (!table) return;

    // Check if there's a pending transition
    if (this.pendingTransitions.has(tableId)) {
      console.log(`🔄 Game ended, processing pending transition for table ${tableId}`);
      await this.handlePendingTransition(table);
      await table.save();
    }
  }

  /**
   * Enhanced ready-up system with choice
   */
  async handlePlayerReady(tableId, username, autoReady = false) {
    const table = await Table.findById(tableId);
    if (!table) return;

    // Add to ready list
    const readySet = new Set(table.readyPlayers || []);
    if (!readySet.has(username)) {
      readySet.add(username);
      table.readyPlayers = Array.from(readySet);
    }

    // ✅ Auto-ready all AI players when any human readies up
    const activePlayers = table.players.filter(p => p.status === 'active');
    const aiPlayers = activePlayers.filter(p => !p.isHuman);
    
    for (const aiPlayer of aiPlayers) {
      if (!readySet.has(aiPlayer.username)) {
        readySet.add(aiPlayer.username);
        console.log(`🤖 Auto-readying AI player: ${aiPlayer.username}`);
      }
    }
    
    // Update ready players list with AI auto-ready
    table.readyPlayers = Array.from(readySet);
    await table.save();

    // Broadcast ready status
    this.io.to(tableId).emit('player_ready_update', {
      readyPlayers: table.readyPlayers,
      username: username,
      autoReady: autoReady
    });

    // Check if all humans are ready
    const humanPlayers = activePlayers.filter(p => p.isHuman);
    const allHumansReady = humanPlayers.every(p => readySet.has(p.username));

    if (allHumansReady && activePlayers.length >= 2) {
      console.log(`🎮 All humans ready, starting new hand at table ${tableId}`);
      await this.startNewHand(table);
    }
  }

  /**
   * Start new hand with enhanced initialization
   */
  async startNewHand(table) {
    console.log(`🎮 Starting new hand at table ${table._id}`);
    
    const { initializeGameState } = require('../models/gameLogic');
    
    // Deduct stake from each player's chips at the start of a new hand
    for (const player of table.players) {
      if (player.isHuman) { // Only deduct from human players
        const user = await User.findOne({ username: player.username });
        if (user) {
          user.chips -= table.stake;
          // Ensure chips don't go below zero if somehow stake is higher than chips
          user.chips = Math.max(0, user.chips);
          await user.save();
          // Update the player object in the table's players array to reflect new chip count
          player.chips = user.chips;
          console.log(`💸 Deducted ${table.stake} chips from ${player.username}. New balance: ${player.chips}`);
        } else {
          // User not found in database - set chips to 0 to prevent NaN validation errors
          player.chips = 0;
          console.warn(`⚠️ User ${player.username} not found in database - setting chips to 0`);
        }
      }
    }

    // Initialize fresh game state
    initializeGameState(table);
    table.status = 'in_progress';
    table.readyPlayers = [];
    
    await table.save();

    // Broadcast game start with proper state sync
    this.io.to(table._id).emit('game_started', {
      gameState: table.gameState,
      message: 'New hand started!',
      timestamp: Date.now()
    });

    // Also broadcast as state_sync to ensure frontend receives the game state
    this.io.to(table._id).emit('state_sync', table.gameState);

    // If first player is AI, trigger AI turn
    if (!table.gameState.gameOver && !table.gameState.players[0].isHuman) {
      setTimeout(() => this.handleAiTurn(table._id), 1000);
    }
  }

  /**
   * Enhanced AI turn handling
   */
  async handleAiTurn(tableId) {
    try {
      const table = await Table.findById(tableId);
      if (!table || !table.gameState) return;

      const updatedState = runAiTurn(table.gameState);
      table.gameState = updatedState;
      await table.save();

      this.io.to(tableId).emit('game_update', updatedState);

      // Check for game end and handle transitions
      if (updatedState.gameOver) {
        await this.handleGameEnd(tableId);
      } else if (!updatedState.players[updatedState.currentTurn].isHuman) {
        setTimeout(() => this.handleAiTurn(tableId), 800);
      }
    } catch (error) {
      console.error('AI turn error:', error);
    }
  }

  /**
   * Check if game can start and start it automatically
   */
  async checkAndStartGame(table) {
    const activePlayers = table.players.filter(p => p.status === 'active');
    
    // Need at least 2 players to start
    if (activePlayers.length >= 2) {
      console.log(`🎮 Auto-starting game at table ${table._id} with ${activePlayers.length} players`);
      
      // ✅ For waiting tables (no game in progress), auto-start with short delay
      if (!table.gameState || !table.gameState.gameStarted) {
        console.log(`🚀 Starting game for waiting table ${table._id} in 2 seconds via enhanced matchmaking`);
        
        // Broadcast countdown to players
        this.io.to(table._id).emit('game_starting_countdown', {
          countdown: 2,
          message: 'Game starting soon...'
        });
        
        // Start game after short delay
        setTimeout(async () => {
          const freshTable = await Table.findById(table._id);
          if (freshTable && (!freshTable.gameState || !freshTable.gameState.gameStarted)) {
            await this.startNewHand(freshTable);
          }
        }, 2000);
        return;
      }
      
      // Initialize ready players array if it doesn't exist
      if (!table.readyPlayers) {
        table.readyPlayers = [];
      }
      
      // Auto-ready all AI players
      const aiPlayers = activePlayers.filter(p => !p.isHuman);
      for (const aiPlayer of aiPlayers) {
        if (!table.readyPlayers.includes(aiPlayer.username)) {
          table.readyPlayers.push(aiPlayer.username);
        }
      }
      
      await table.save();
      
      // Check if all humans are ready or if we should auto-start
      const humanPlayers = activePlayers.filter(p => p.isHuman);
      const readyHumans = humanPlayers.filter(p => table.readyPlayers.includes(p.username));
      
      // Auto-start if all humans are ready OR if there's only 1 human and AI
      if (readyHumans.length === humanPlayers.length || (humanPlayers.length === 1 && aiPlayers.length >= 1)) {
        // Check if game is not already started to prevent duplicates
        if (!table.gameState || !table.gameState.gameStarted) {
          await this.startNewHand(table);
        }
      } else {
        // Broadcast ready status
        this.io.to(table._id).emit('table_players_update', {
          players: table.players,
          spectators: table.spectators || [],
          readyPlayers: table.readyPlayers || []
        });
      }
    }
  }

  /**
   * Handle queue overflow by creating new tables only when necessary
   */
  async handleQueueOverflow() {
    const queues = getQueues();
    
    for (const [stake, queue] of queues) {
      if (queue.length === 0) continue;
      
      // Check if existing tables for this stake can accommodate more players
      const existingTables = await Table.find({ stake: stake });
      const availableSpots = existingTables.reduce((total, table) => {
        const activePlayerCount = table.players.filter(p => p.status === 'active').length;
        return total + Math.max(0, 4 - activePlayerCount);
      }, 0);
      
      // Only create new table if no existing tables can accommodate waiting players
      if (queue.length > availableSpots && existingTables.every(t => t.players.length >= 4)) {
        console.log(`📋 Creating new table for stake $${stake} - queue overflow (${queue.length} waiting, ${availableSpots} spots available)`);
        
        // Create new table and assign first player
        const firstPlayer = queue.shift();
        if (firstPlayer) {
          const newTable = new Table({
            name: `$${stake} Table`,
            stake: stake,
            players: [{
              username: firstPlayer.username,
              chips: firstPlayer.chips,
              isHuman: true,
              socketId: firstPlayer.socketId,
              joinedAt: new Date(),
              status: 'active'
            }],
            status: 'waiting',
            spectators: [],
            readyPlayers: []
          });
          
          await newTable.save();
          
          // Notify player of table assignment
          this.io.to(firstPlayer.socketId).emit('table_assigned', {
            tableId: newTable._id,
            seat: 0,
            stake: stake,
            playerCount: 1,
            message: `Joined $${stake} table`,
            gameStatus: 'waiting',
            canPlayImmediately: true
          });
          
          console.log(`✅ ${firstPlayer.username} assigned to new $${stake} table ${newTable._id}`);
          
          // Add AI companion for immediate play
          await this.addAiPlayer(newTable);
          await this.checkAndStartGame(newTable);
          await newTable.save();
        }
      }
    }
  }
}

module.exports = EnhancedMatchmaking;
