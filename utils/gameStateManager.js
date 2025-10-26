const { Table } = require('../models/Table');
const { processGameAction, initializeGameState } = require('../models/gameLogic');
const { runAiTurn } = require('../models/AiPlayer');
const { removeFromQueue, getQueues } = require('./smartQueueManager');
const User = require('../models/User'); // Import User model

/**
 * Enhanced Game State Manager
 * Handles complex game state transitions, spectator modes, and seamless player integration
 */

class GameStateManager {
  constructor(io) {
    this.io = io;
    this.activeTransitions = new Map(); // Track ongoing transitions
    this.spectatorStates = new Map(); // Track spectator-specific states
    this.gameEventHistory = new Map(); // Track game events for replay
  }

  /**
   * Handle player joining mid-game with graceful transition
   */
  async handleMidGameJoin(tableId, newPlayer) {
    const table = await Table.findById(tableId);
    if (!table) {
      throw new Error('Table not found');
    }

    // If no game state exists, this is a normal join to a waiting table
    if (!table.gameState || !table.gameState.gameStarted) {
      return this.handleNormalJoin(table, newPlayer);
    }

    const gameState = table.gameState;
    const hasAiPlayer = table.players.some(p => !p.isHuman);

    if (!gameState.gameStarted || gameState.gameOver) {
      // Game not active, can join normally
      return this.handleNormalJoin(table, newPlayer);
    }

    if (hasAiPlayer) {
      // AI present, initiate graceful transition
      return this.initiateAiToHumanTransition(table, newPlayer);
    } else {
      // No AI, add as spectator until next hand
      return this.addAsSpectatorUntilNextHand(table, newPlayer);
    console.log(`[DEBUG] handleMidGameJoin: Adding ${newPlayer.username} as spectator until next hand at table ${table._id}`);
   }
  }

  /**
   * Initiate AI to human transition
   */
  async initiateAiToHumanTransition(table, newPlayer) {
    // Check if this player already has an active transition
    const existingTransition = Array.from(this.activeTransitions.values())
      .find(t => t.tableId.toString() === table._id.toString() && t.newPlayer.username === newPlayer.username);
    
    if (existingTransition) {
      console.log(`🔄 Transition already exists for ${newPlayer.username} at table ${table._id}`);
      return { success: true, mode: 'spectating', transitionId: existingTransition.id };
    }
  
    const transitionId = `${table._id}_${Date.now()}`;
    
    // Create transition state
    const transition = {
      id: transitionId,
      tableId: table._id,
      newPlayer: newPlayer,
      startTime: Date.now(),
      phase: 'spectating', // spectating -> hand_completing -> transitioning -> completed
      aiPlayerToReplace: table.players.find(p => !p.isHuman),
      originalGameState: { ...table.gameState }
    };
  
    this.activeTransitions.set(transitionId, transition);
  
    // Add player as special spectator
    await this.addTransitionSpectator(table, newPlayer, transitionId);

    // --- CRITICAL FIX: Remove player from queue for this stake if present ---
    if (typeof table.stake !== 'undefined' && newPlayer.username) {
      removeFromQueue(table.stake, newPlayer.username);
    }
  
    // Notify all players about incoming transition
    this.io.to(table._id).emit('transition_initiated', {
      type: 'ai_replacement',
      newPlayerName: newPlayer.username,
      message: `${newPlayer.username} will join after this hand completes`,
      estimatedTime: this.estimateHandCompletionTime(table.gameState),
      transitionId: transitionId
    });
  
    // Send spectator view to new player
    const spectatorState = this.createSpectatorGameState(table.gameState, newPlayer);
    this.io.to(newPlayer.socketId).emit('spectator_mode_active', {
      gameState: spectatorState,
      message: 'Watching current hand - you\'ll join when it completes',
      transitionId: transitionId,
      yourTurnNext: true,
      tableId: table._id.toString()
    });
  
    console.log(`🔄 Initiated AI transition for ${newPlayer.username} at table ${table._id}`);
    return { success: true, mode: 'spectating', transitionId };
  }

  /**
   * Add player as transition spectator
   */
  async addTransitionSpectator(table, player, transitionId) {
    if (!table.spectators) table.spectators = [];
    
    table.spectators.push({
      username: player.username,
      socketId: player.socketId,
      joinedAt: new Date(),
      chips: player.chips,
      isHuman: true,
      transitionId: transitionId,
      type: 'transition_spectator'
    });

    console.log(`[DEBUG] addTransitionSpectator: Added spectator ${player.username} with transitionId ${transitionId}`);
    console.log(`[DEBUG] addTransitionSpectator: Current spectators:`, table.spectators);

    await table.save();
  
    // --- Emit updated table players and spectators to all clients at the table ---
    this.io.to(table._id).emit('table_players_update', {
      players: table.players,
      spectators: table.spectators || [],
      readyPlayers: table.readyPlayers || []
    });
  }

  /**
   * Create spectator-safe game state
   */
  createSpectatorGameState(gameState, spectator) {
    const spectatorState = {
      ...gameState,
      // Hide other players' hands but show public information
      playerHands: gameState.playerHands.map((hand, index) => {
        // Show card count but hide actual cards
        return Array(hand.length).fill({ rank: 'hidden', suit: 'hidden' });
      }),
      // Keep spreads visible (public information)
      playerSpreads: gameState.playerSpreads,
      // Keep discard pile visible
      discardPile: gameState.discardPile,
      // Hide deck
      deck: [],
      // Add spectator metadata
      spectatorMode: true,
      spectatorName: spectator.username,
      canInteract: false,
      message: 'Spectating current hand'
    };

    return spectatorState;
  }

  /**
   * Handle normal join (game not active)
   */
  async handleNormalJoin(table, newPlayer) {
    // Add player normally
    table.players.push({
      username: newPlayer.username,
      chips: newPlayer.chips,
      isHuman: true,
      socketId: newPlayer.socketId,
      joinedAt: new Date(),
      status: 'active'
    });

    await table.save();

    // Notify player of successful join
    this.io.to(newPlayer.socketId).emit('table_joined_successfully', {
      tableId: table._id,
      seat: table.players.length - 1,
      canPlayImmediately: true,
      message: 'Welcome to the table!'
    });

    // Check if we can start the game immediately (if we have enough players)
    await this.checkAndStartGame(table);

    return { success: true, mode: 'player' };
  }

  /**
   * Add as spectator until next hand
   */
  async addAsSpectatorUntilNextHand(table, newPlayer) {
    if (!table.spectators) table.spectators = [];
    
    table.spectators.push({
      username: newPlayer.username,
      socketId: newPlayer.socketId,
      joinedAt: new Date(),
      chips: newPlayer.chips,
      isHuman: true,
      type: 'waiting_spectator',
      willJoinNextHand: true
    });

    await table.save();

    // Send spectator view
    const spectatorState = this.createSpectatorGameState(table.gameState, newPlayer);
    this.io.to(newPlayer.socketId).emit('spectator_mode_active', {
      gameState: spectatorState,
      message: 'Table is full - you\'ll join the next hand',
      willJoinNextHand: true,
      tableId: table._id.toString()
    });

    return { success: true, mode: 'spectating_until_next_hand' };
  }

  /**
   * Check and process pending transitions
   */
  async checkPendingTransitions() {
    for (const [transitionId, transition] of this.activeTransitions) {
      const table = await Table.findById(transition.tableId);
      if (!table) {
        this.activeTransitions.delete(transitionId);
        continue;
      }

      // Check if hand is complete
      if (!table.gameState || table.gameState.gameOver || !table.gameState.gameStarted) {
        await this.completeTransition(transitionId, table);
        console.log(`[DEBUG] checkPendingTransitions: Completing transition ${transitionId} for table ${table._id}`);
      }
    }
  }

  /**
   * Complete AI to human transition
   */
  async completeTransition(transitionId, table) {
    const transition = this.activeTransitions.get(transitionId);
    if (!transition) return;
  
    console.log(`✅ Completing transition ${transitionId} for table ${table._id}`);
    console.log(`[DEBUG] completeTransition: Looking for spectator with transitionId ${transitionId}`);
    console.log(`[DEBUG] completeTransition: Current spectators:`, table.spectators);

    // Find the transition spectator
    const transitionSpectator = table.spectators.find(s => s.transitionId === transitionId);
    if (!transitionSpectator) {
      console.error(`Transition spectator not found for ${transitionId}`);
      this.activeTransitions.delete(transitionId);
      return;
    }

    // Remove AI player
    const aiPlayer = table.players.find(p => !p.isHuman);
    if (aiPlayer) {
      table.players = table.players.filter(p => p.isHuman);
      console.log(`🤖 Removed AI player: ${aiPlayer.username}`);
    }

    // Move spectator to player
    table.players.push({
      username: transitionSpectator.username,
      chips: transitionSpectator.chips,
      isHuman: true,
      socketId: transitionSpectator.socketId,
      joinedAt: new Date(),
      status: 'active'
    });

    // Remove from spectators
    table.spectators = table.spectators.filter(s => s.transitionId !== transitionId);

    // Reset for new hand
    table.gameState = null;
    table.status = 'waiting';
    table.readyPlayers = [];

    await table.save();

    // Notify all players
    this.io.to(table._id).emit('transition_completed', {
      type: 'ai_replacement_complete',
      newPlayer: transitionSpectator.username,
      message: `${transitionSpectator.username} has joined the table`,
      readyForNewHand: true
    });

    // Notify the new player
    this.io.to(transitionSpectator.socketId).emit('player_mode_activated', {
      tableId: table._id,
      message: 'You\'re now a player! Get ready for the next hand.',
      seatPosition: table.players.length - 1
    });

    // Clean up
    this.activeTransitions.delete(transitionId);
    console.log(`🎉 Transition completed for ${transitionSpectator.username}`);
    // --- After transition completes, broadcast lobby/table updates ---
    // (This is inside completeTransition, after transition is deleted)
    // ...existing code...
    // Clean up
    this.activeTransitions.delete(transitionId);
    console.log(`🎉 Transition completed for ${transitionSpectator.username}`);

    // Broadcast updated tables to all clients (lobby)
    const updatedTables = await Table.find();
    this.io.emit('tables_update', { tables: updatedTables });

    // Broadcast updated player list for this table
    this.io.to(table._id).emit('table_players_update', {
      players: table.players,
      spectators: table.spectators || [],
      readyPlayers: table.readyPlayers || []
    });

    // After transition, trigger the same logic as when a new hand is possible (countdown or wait for ready)
    await this.checkAndStartGame(table);
  }

  /**
   * Handle game end with transition processing
   */
  async handleGameEnd(tableId, gameState) {
    // Process any pending transitions
    await this.checkPendingTransitions();

    // Handle waiting spectators
    const table = await Table.findById(tableId);
    if (table && table.spectators) {
      const waitingSpectators = table.spectators.filter(s => s.willJoinNextHand);
      
      for (const spectator of waitingSpectators) {
        if (table.players.length < 4) {
          // Move spectator to player for next hand
          table.players.push({
            username: spectator.username,
            chips: spectator.chips,
            isHuman: true,
            socketId: spectator.socketId,
            joinedAt: new Date(),
            status: 'active'
          });

          // Remove from spectators
          table.spectators = table.spectators.filter(s => s.username !== spectator.username);

          // Notify player
          this.io.to(spectator.socketId).emit('promoted_to_player', {
            message: 'You can now play in the next hand!',
            seatPosition: table.players.length - 1
          });
        }
      }

      await table.save();
    }
  }

  /**
   * Estimate hand completion time
   */
  estimateHandCompletionTime(gameState) {
    if (!gameState || gameState.gameOver) return 0;

    // Calculate based on remaining cards and players
    const avgCardsPerPlayer = gameState.playerHands.reduce((sum, hand) => sum + hand.length, 0) / gameState.players.length;
    const estimatedTurns = avgCardsPerPlayer * gameState.players.length;
    const avgTurnTime = 15; // seconds per turn

    return Math.round(estimatedTurns * avgTurnTime);
  }

  /**
   * Create enhanced ready-up system
   */
  async handlePlayerReady(tableId, username, options = {}) {
    // ✅ Always fetch fresh table state to avoid stale data
    const table = await Table.findById(tableId);
    if (!table) return;

    const { autoReady = false, skipConfirmation = false } = options;

    // 🔍 Enhanced debug logging to trace the exact state
    console.log(`🔍 handlePlayerReady called for ${username} at table ${tableId}`);
    console.log(`🔍 Fresh table game state:`, {
      hasGameState: !!table.gameState,
      gameStarted: table.gameState?.gameStarted,
      gameOver: table.gameState?.gameOver,
      winType: table.gameState?.winType,
      winners: table.gameState?.winners,
      timestamp: table.gameState?.timestamp
    });

    // Add to ready list
    const readySet = new Set(table.readyPlayers || []);
    if (!readySet.has(username)) {
      readySet.add(username);
      table.readyPlayers = Array.from(readySet);
    }

    // ✅ Auto-ready all AI players when any human readies up (only after game ends)
    const activePlayers = table.players.filter(p => p.status === 'active');
    const aiPlayers = activePlayers.filter(p => !p.isHuman);
    
    // ✅ FIXED: Always auto-ready AI players when humans ready up after game end
    // The issue was that gameOver state wasn't syncing properly to database
    console.log(`🔍 AI auto-ready check: gameState exists: ${!!table.gameState}, gameStarted: ${table.gameState?.gameStarted}, gameOver: ${table.gameState?.gameOver}`);
    
    // Auto-ready AI players ONLY when game is actually over or not started
    // Don't allow ready-up during active games
    const shouldAutoReadyAI = !table.gameState ||
                             !table.gameState.gameStarted ||
                             table.gameState.gameOver;
    
    if (shouldAutoReadyAI) {
      console.log(`🤖 AI auto-ready conditions met - processing ${aiPlayers.length} AI players`);
      for (const aiPlayer of aiPlayers) {
        if (!readySet.has(aiPlayer.username)) {
          readySet.add(aiPlayer.username);
          console.log(`🤖 Auto-readying AI player: ${aiPlayer.username} (gameOver: ${table.gameState?.gameOver}, manual ready: ${!autoReady})`);
        }
      }
    } else {
      console.log(`🤖 Skipping AI auto-ready - game in progress (gameOver: ${table.gameState?.gameOver})`);
    }
    
    // Update ready players list with AI auto-ready
    table.readyPlayers = Array.from(readySet);
    await table.save();

    // Broadcast ready status with enhanced info
    this.io.to(tableId).emit('player_ready_update', {
        readyPlayers: table.readyPlayers,
        username: username,
        autoReady: autoReady,
        totalPlayers: table.players.filter(p => p.isHuman).length,
        readyCount: table.readyPlayers.length
    });

    // --- Always check for pending transitions after any ready-up, including spectators ---
    await this.checkPendingTransitions();

    // Re-fetch the table and use the latest state for ready check and new hand
    const latestTable = await Table.findById(tableId);
    const latestGameState = latestTable?.gameState;
    const latestActivePlayers = latestTable?.players?.filter(p => p.status === 'active') || [];
    const latestHumanPlayers = latestActivePlayers.filter(p => p.isHuman);
    const latestReadySet = new Set(latestTable?.readyPlayers || []);
    const latestAllHumansReady = latestHumanPlayers.every(p => latestReadySet.has(p.username));

    // Only start new hand if there are no pending transitions and game is actually over or not started
    const hasPendingTransition = Array.from(this.activeTransitions.values()).some(
        t => t.tableId.toString() === tableId.toString()
    );

    if (!hasPendingTransition && latestAllHumansReady && latestActivePlayers.length >= 2) {
        if (!latestGameState || !latestGameState.gameStarted || latestGameState.gameOver) {
            console.log(`🎮 All humans ready, starting new hand at table ${tableId} (latest state)`);
            console.log(`🔍 Current game state: gameStarted: ${latestGameState?.gameStarted}, gameOver: ${latestGameState?.gameOver}`);
            await this.startNewHand(latestTable);
        } else {
            console.log(`🚫 Cannot start new hand - game in progress at table ${tableId} (latest state)`);
            console.log(`🔍 Current game state: gameStarted: ${latestGameState?.gameStarted}, gameOver: ${latestGameState?.gameOver}`);
        }
        console.log(`[DEBUG] handlePlayerReady: All humans ready, checking game state before starting new hand:`, {
          gameStarted: latestGameState?.gameStarted,
          gameOver: latestGameState?.gameOver,
          hasPendingTransition: hasPendingTransition
        });
      }
  }

  /**
   * Start new hand with enhanced features
   */
  async startNewHand(table) {
    console.log(`[DEBUG] startNewHand: Starting new hand at table ${table._id}`);
    console.log(`🎮 Starting new hand at table ${table._id}`);

    // ✅ Completely clear old game state before initializing new one
    table.gameState = null;
    table.status = 'waiting';
    table.readyPlayers = [];
    
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
        }
      }
    }

    // Initialize fresh game state
    initializeGameState(table);
    table.status = 'in_progress';

    // Add game start event to history
    this.addGameEvent(table._id, {
      type: 'hand_started',
      timestamp: Date.now(),
      players: table.players.map(p => p.username),
      stake: table.stake
    });

    await table.save();

    // Broadcast enhanced game start with proper state sync
    this.io.to(table._id).emit('game_started', {
      gameState: table.gameState,
      message: 'New hand started!',
      timestamp: Date.now(),
      handNumber: this.getHandNumber(table._id)
    });

    // Also broadcast as state_sync to ensure frontend receives the game state
    this.io.to(table._id).emit('state_sync', table.gameState);

    // Handle first turn
    if (!table.gameState.gameOver && !table.gameState.players[0].isHuman) {
      setTimeout(() => this.handleAiTurn(table._id), 1000);
    }
  }

  /**
   * Enhanced AI turn handling
   */
  async handleAiTurn(tableId) {
    console.log(`🤖 GameStateManager: handleAiTurn called for table ${tableId}`);
    try {
      const table = await Table.findById(tableId);
      if (!table || !table.gameState) {
        console.log(`🤖 GameStateManager: Table ${tableId} or gameState not found. Exiting AI turn.`);
        return;
      }

      console.log(`🤖 GameStateManager: Before runAiTurn - currentTurn: ${table.gameState.currentTurn}, gameOver: ${table.gameState.gameOver}`);
      const updatedState = await runAiTurn(table.gameState);
      console.log(`🤖 GameStateManager: After runAiTurn - currentTurn: ${updatedState.currentTurn}, gameOver: ${updatedState.gameOver}, winType: ${updatedState.winType}`);

      table.gameState = updatedState;
      await table.save();
      console.log(`🤖 GameStateManager: Game state saved for table ${tableId}.`);

      // Broadcast with enhanced info
      this.io.to(tableId).emit('game_update', {
        ...updatedState,
        lastAction: 'ai_turn',
        timestamp: Date.now()
      });
      console.log(`🤖 GameStateManager: Emitted game_update for table ${tableId}.`);

      // Check for game end
      if (updatedState.gameOver) {
        console.log(`🤖 GameStateManager: Game over detected. Calling handleGameEnd.`);
        await this.handleGameEnd(tableId, updatedState);
      } else if (!updatedState.players[updatedState.currentTurn].isHuman) {
        console.log(`🤖 GameStateManager: Next turn is AI. Scheduling next AI turn in 800ms.`);
        setTimeout(() => this.handleAiTurn(tableId), 800);
      } else {
        console.log(`🤖 GameStateManager: Next turn is human. AI turn sequence complete.`);
      }
    } catch (error) {
      console.error('🚨 Enhanced AI turn error:', error);
    }
  }

  /**
   * Add game event to history
   */
  addGameEvent(tableId, event) {
    if (!this.gameEventHistory.has(tableId)) {
      this.gameEventHistory.set(tableId, []);
    }
    
    const history = this.gameEventHistory.get(tableId);
    history.push(event);
    
    // Keep only recent events (last 100)
    if (history.length > 100) {
      history.shift();
    }
  }

  /**
   * Get hand number for table
   */
  getHandNumber(tableId) {
    const history = this.gameEventHistory.get(tableId) || [];
    return history.filter(event => event.type === 'hand_started').length;
  }

  /**
   * Get transition status for table
   */
  getTransitionStatus(tableId) {
    const transitions = Array.from(this.activeTransitions.values())
      .filter(t => t.tableId.toString() === tableId.toString());
    
    return transitions.length > 0 ? transitions[0] : null;
  }

  /**
   * Cleanup expired transitions
   */
  cleanupExpiredTransitions(maxAgeMinutes = 30) {
    const cutoffTime = Date.now() - (maxAgeMinutes * 60 * 1000);
    
    for (const [transitionId, transition] of this.activeTransitions) {
      if (transition.startTime < cutoffTime) {
        console.log(`🧹 Cleaning up expired transition: ${transitionId}`);
        this.activeTransitions.delete(transitionId);
      }
    }
  }

  /**
   * Check if game can start and start it automatically
   */
  async checkAndStartGame(table) {
    const activePlayers = table.players.filter(p => p.status === 'active');
    const humanPlayers = activePlayers.filter(p => p.isHuman);
    const aiPlayers = activePlayers.filter(p => !p.isHuman);
    
    // ✅ Add AI if only 1 human and no AI present
    if (humanPlayers.length === 1 && aiPlayers.length === 0) {
      console.log(`🤖 Adding AI companion for lone human at table ${table._id}`);
      await this.addAiPlayer(table);
      // Refresh player counts after adding AI
      const refreshedActivePlayers = table.players.filter(p => p.status === 'active');
      console.log(`🎮 Table ${table._id} now has ${refreshedActivePlayers.length} players after AI addition`);
    }
    
    // Refresh counts after potential AI addition
    const finalActivePlayers = table.players.filter(p => p.status === 'active');
    
    // Need at least 2 players to start
    if (finalActivePlayers.length >= 2) {
      console.log(`🎮 Auto-starting game at table ${table._id} with ${finalActivePlayers.length} players`);
      
      // ✅ For waiting tables (no game in progress), auto-start with short delay
      if (!table.gameState || !table.gameState.gameStarted) {
        console.log(`🚀 Starting game for waiting table ${table._id} in 2 seconds`);
        
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
      const finalAiPlayers = finalActivePlayers.filter(p => !p.isHuman);
      for (const aiPlayer of finalAiPlayers) {
        if (!table.readyPlayers.includes(aiPlayer.username)) {
          table.readyPlayers.push(aiPlayer.username);
        }
      }
      
      await table.save();
      
      // Check if all humans are ready or if we should auto-start
      const finalHumanPlayers = finalActivePlayers.filter(p => p.isHuman);
      const readyHumans = finalHumanPlayers.filter(p => table.readyPlayers.includes(p.username));
      
      // Auto-start if all humans are ready OR if there's only 1 human and AI
      if (readyHumans.length === finalHumanPlayers.length || (finalHumanPlayers.length === 1 && finalAiPlayers.length >= 1)) {
        // Check if game is not already started OR if current game is over
        if (!table.gameState || !table.gameState.gameStarted || table.gameState.gameOver) {
          console.log(`🎮 All conditions met, starting new hand at table ${table._id}`);
          await this.startNewHand(table);
        } else {
          console.log(`🔄 Game already in progress at table ${table._id}, not starting new hand`);
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
   * Add AI player to table
   */
  async addAiPlayer(table) {
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
    await table.save();
    
    console.log(`🤖 Added AI player ${aiPlayerName} to table ${table._id}`);
    
    // Broadcast the update
    this.io.to(table._id).emit('table_players_update', {
      players: table.players,
      spectators: table.spectators || [],
      readyPlayers: table.readyPlayers || []
    });
  }




  /**
   * Register a pending transition from matchmaking (for cross-system sync)
   */
  registerTransitionFromMatchmaking(table, newPlayer) {
    // Avoid duplicate transitions
    const existing = Array.from(this.activeTransitions.values())
      .find(t => t.tableId.toString() === table._id.toString() && t.newPlayer.username === newPlayer.username);
    if (existing) return;

    const transitionId = `${table._id}_${Date.now()}`;
    const transition = {
      id: transitionId,
      tableId: table._id,
      newPlayer: newPlayer,
      startTime: Date.now(),
      phase: 'spectating',
      aiPlayerToReplace: table.players.find(p => !p.isHuman),
      originalGameState: { ...table.gameState }
    };
    this.activeTransitions.set(transitionId, transition);
    console.log(`🔄 [Sync] Registered transition in GameStateManager for ${newPlayer.username} at table ${table._id}`);
  }
}

module.exports = GameStateManager;
