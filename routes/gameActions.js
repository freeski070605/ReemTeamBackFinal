const { processGameAction } = require('../models/gameLogic');
const { runAiTurn } = require('../models/AiPlayer');
const { Table } = require('../models/Table');
const User = require('../models/User');
const wageringService = require('../utils/wageringService');
const Game = require('../models/Game');

const GameStateManager = require('../utils/gameStateManager');

// ✅ ENHANCED TURN VALIDATION: More lenient for discard actions and state sync recovery
const validateTurnAction = (gameState, socketId, action) => {
     // Check if game is active
     if (!gameState || gameState.gameOver) {
         console.log(`🚫 TURN_VALIDATION: Game over or not started - rejecting action ${action}`);
         return { valid: false, reason: 'Game not active' };
     }

     // Check turn ownership with enhanced logging
     const currentPlayer = gameState.players[gameState.currentTurn];
     if (!currentPlayer) {
         console.log(`🚫 TURN_VALIDATION: No current player found at turn ${gameState.currentTurn}`);
         return { valid: false, reason: 'Invalid game state - no current player' };
     }

     // ✅ LENIENT DISCARD VALIDATION: Allow discard if player owns the turn (more forgiving)
     const isPlayerTurn = currentPlayer.socketId === socketId;
     if (!isPlayerTurn) {
         // For DISCARD actions, be more lenient - check if this might be a state sync issue
         if (action === 'DISCARD') {
             console.log(`⚠️ TURN_VALIDATION: DISCARD action from non-current player ${socketId}, checking for state sync issues...`);
             // Find the player who sent the action
             const requestingPlayer = gameState.players.find(p => p.socketId === socketId);
             if (requestingPlayer) {
                 console.log(`🔍 TURN_VALIDATION: Requesting player found: ${requestingPlayer.username}, current player: ${currentPlayer.username}`);
                 // Allow discard if it's clearly a state synchronization issue (player is waiting to discard)
                 if (gameState.hasDrawnCard && requestingPlayer.username === currentPlayer.username) {
                     console.log(`✅ TURN_VALIDATION: Allowing DISCARD due to likely state sync - player ${requestingPlayer.username} has drawn card`);
                     return { valid: true, warning: 'State sync issue detected - allowing discard' };
                 }
             }
             console.log(`🚫 TURN_VALIDATION: DISCARD blocked - not player's turn (${socketId} vs ${currentPlayer.socketId})`);
             return { valid: false, reason: 'Not your turn - discard blocked' };
         } else {
             console.log(`🚫 TURN_VALIDATION: Not player's turn - current: ${currentPlayer.username} (${currentPlayer.socketId}), requesting: ${socketId}`);
             return { valid: false, reason: 'Not your turn' };
         }
     }

     // Check action timing with DISCARD-specific leniency
     if (action === 'DRAW_CARD' && gameState.hasDrawnCard) {
         console.log(`🚫 TURN_VALIDATION: Already drawn card this turn`);
         return { valid: false, reason: 'Already drawn card' };
     }

     // ✅ REEMTEAM VARIANT: Allow discard from initial hand (no hasDrawnCard requirement)
     if ((action === 'SPREAD' || action === 'HIT') && !gameState.hasDrawnCard) {
         console.log(`🚫 TURN_VALIDATION: Must draw card before ${action}`);
         return { valid: false, reason: 'Must draw card first' };
     }

     console.log(`✅ TURN_VALIDATION: Action ${action} validated for player ${currentPlayer.username}`);
     return { valid: true };
 };

const handleGameAction = async (io, socket, { tableId, action, payload, clientStateHash }, gameStateManagerInstance) => {
    try {
        console.log(`🎯 handleGameAction: ${action} from socket ${socket.id} at table ${tableId}`);
        console.log(`[SOCKET_DEBUG] Backend: Socket ID: ${socket.id}`);
        console.log(`📨 GAME_ACTION RECEIVED: Action=${action}, Payload=${JSON.stringify(payload)}, Timestamp=${Date.now()}`);

        // ✅ DESYNC DETECTION: Check client state hash against server state
        if (clientStateHash) {
            const table = await Table.findById(tableId);
            if (table && table.gameState) {
                const serverHash = gameStateManagerInstance.calculateStateHash(table.gameState);

                if (serverHash !== clientStateHash) {
                    console.log(`⚠️ DESYNC DETECTED: Client hash ${clientStateHash} != Server hash ${serverHash} for table ${tableId}`);

                    // Trigger state reconciliation
                    const reconciliationResult = await gameStateManagerInstance.reconcileGameState(tableId, null, clientStateHash);

                    if (!reconciliationResult.reconciled) {
                        socket.emit('error', { message: 'State desynchronization detected. Please refresh your game.' });
                        return;
                    }

                    // Send reconciled state to client
                    socket.emit('state_reconciled', {
                        serverState: reconciliationResult.state,
                        message: 'Game state synchronized with server'
                    });
                }
            }
        }

        if (!tableId) {
            socket.emit('error', { message: 'No table ID provided.' });
            return;
        }

        console.log(`[SOCKET_DEBUG] Backend: Socket ID: ${socket.id}`);


        const table = await Table.findById(tableId);
        if (!table) {
            console.error(`Table ${tableId} not found in database`);
            socket.emit('error', { message: 'Table or game state not found.' });
            return;
        }

        if (!table.gameState) {
            console.error(`Table ${tableId} has no game state`);
            socket.emit('error', { message: 'Table or game state not found.' });
            return;
        }

        // Additional validation - check if player is actually at this table and update socket ID if needed
        let playerAtTable = table.players.find(p => p.socketId === socket.id);
        if (!playerAtTable) {
            // Check if any player at the table has the same username as the socket
            const player = table.players.find(p => p.username === socket.userId);
            if (player) {
                console.log(`Updating socket ID for player ${player.username} from ${player.socketId} to ${socket.id}`);
                player.socketId = socket.id;
                playerAtTable = player; // Assign the found player to playerAtTable
                await table.save();
            } else {
                console.error(`Socket ${socket.id} is not a player at table ${tableId}`);
                socket.emit('error', { message: 'You are not a player at this table.' });
                return;
            }
        }

        const currentPlayer = table.gameState.players[table.gameState.currentTurn];
        console.log(`🎯 handleGameAction: Current player: ${currentPlayer.username} (socketId: ${currentPlayer.socketId}), Action from: ${socket.id}`);

        // Ensure the socket ID in gameState is up-to-date
        if (currentPlayer.socketId !== socket.id) {
          console.warn(`⚠️ Socket ID mismatch detected - updating gameState.players[${table.gameState.currentTurn}].socketId from ${currentPlayer.socketId} to ${socket.id}`);
          currentPlayer.socketId = socket.id;
          table.gameState.players[table.gameState.currentTurn].socketId = socket.id;
          await table.save();
        }
        
        if (currentPlayer.socketId !== socket.id) {
            socket.emit('error', { message: 'Not your turn.' });
            return;
        }

        console.log(`🎯 handleGameAction: Before processing - gameOver: ${table.gameState.gameOver}`);

        // ✅ ENHANCED TURN VALIDATION: More lenient for discard with better error handling
        const turnValidation = validateTurnAction(table.gameState, socket.id, action);
        if (!turnValidation.valid) {
           console.log(`🚫 TURN_VALIDATION_FAILED: ${turnValidation.reason} for action ${action}`);
           console.log(`🔍 TURN_VALIDATION_DEBUG: Current state - Turn: ${table.gameState.currentTurn}, GameOver: ${table.gameState.gameOver}, HasDrawnCard: ${table.gameState.hasDrawnCard}`);
           console.log(`🔍 TURN_VALIDATION_DEBUG: Current player: ${currentPlayer?.username} (socket: ${currentPlayer?.socketId}), Requesting socket: ${socket.id}`);

           // ✅ FOR DISCARD FAILURES: Trigger state sync instead of just rejecting
           if (action === 'DISCARD') {
               console.log(`🔄 [DISCARD_RECOVERY] DISCARD validation failed, triggering state synchronization...`);
               // Request state sync from client perspective
               socket.emit('request_state_sync', {
                   tableId: tableId,
                   reason: `DISCARD validation failed: ${turnValidation.reason}`,
                   failedAction: payload,
                   action: action
               });

               // Send a more helpful error message for discard
               socket.emit('turn_validation_error', {
                 errorMessage: `${turnValidation.reason}. Attempting to synchronize game state...`,
                 errorType: 'TURN_VALIDATION_FAILED_DISCARD',
                 suggestedAction: 'State synchronization in progress. Please wait and try again.',
                 action: action,
                 timestamp: Date.now(),
                 willRetry: true
               });

               // Send Unity-specific validation error with recovery info
               io.to(tableId).emit('unity_turn_validation_error', {
                 errorMessage: turnValidation.reason,
                 errorType: 'TURN_VALIDATION_FAILED_DISCARD',
                 playerUsername: currentPlayer.username,
                 action: action,
                 recoveryInProgress: true
               });

               // Auto-retry the discard after a short delay to allow state sync
               setTimeout(() => {
                   console.log(`🔄 [DISCARD_RECOVERY] Auto-retrying DISCARD action after validation failure`);
                   // Re-emit the game action with the original payload
                   socket.emit('game_action', { tableId, action, payload });
               }, 2000);

               return;
           } else {
               // For non-discard actions, use original error handling
               socket.emit('turn_validation_error', {
                 errorMessage: turnValidation.reason,
                 errorType: 'TURN_VALIDATION_FAILED',
                 suggestedAction: 'Please wait for your turn or refresh the game state',
                 action: action,
                 timestamp: Date.now()
               });

               // Send Unity-specific validation error
               io.to(tableId).emit('unity_turn_validation_error', {
                 errorMessage: turnValidation.reason,
                 errorType: 'TURN_VALIDATION_FAILED',
                 playerUsername: currentPlayer.username,
                 action: action
               });

               return;
           }
        }

        // Log validation warnings for monitoring
        if (turnValidation.warning) {
           console.log(`⚠️ TURN_VALIDATION_WARNING: ${turnValidation.warning} for action ${action}`);
        }

        // Process action synchronously with additional logging
        console.log(`🔄 PROCESSING ACTION: ${action} with payload:`, JSON.stringify(payload));
        console.log(`🎯 handleGameAction: Before processing - hasDrawnCard: ${table.gameState.hasDrawnCard}, currentTurn: ${table.gameState.currentTurn}`);
    
        // Special handling for game start action
        let updatedState;
        if (action === 'START_GAME') {
            // Initialize fresh game state
            const { initializeGameState } = require('../models/gameLogic');
            initializeGameState(table);
            updatedState = table.gameState;
            console.log(`🎮 GAME_START: Initialized game state for table ${tableId}`);
        } else {
            updatedState = processGameAction(table.gameState, action, payload);
        }
        console.log(`🎯 handleGameAction: After processing - gameOver: ${updatedState.gameOver}, winType: ${updatedState.winType}, winners: [${updatedState.winners?.join(',') || ''}]`);
        console.log(`🔄 STATE_TRANSFORM: Action=${action}, Pre-hasDrawnCard=${table.gameState.hasDrawnCard}, Post-hasDrawnCard=${updatedState.hasDrawnCard}`);
        console.log(`🔄 STATE_TRANSFORM: Action=${action}, Pre-gameOver=${table.gameState.gameOver}, Post-gameOver=${updatedState.gameOver}`);

        console.log(`📝 handleGameAction: About to assign updatedState with gameOver: ${updatedState.gameOver}`);
        table.gameState = updatedState;
        // Additional logging for state consistency
        console.log(`🔍 STATE_CONSISTENCY: Before save - gameState.gameOver: ${table.gameState.gameOver}, updatedState.gameOver: ${updatedState.gameOver}`);
        console.log(`🔍 STATE_CONSISTENCY: Player hands lengths: ${table.gameState.playerHands?.map(h => h.length).join(',')}`);
        console.log(`🔍 STATE_CONSISTENCY: Current turn: ${table.gameState.currentTurn}`);

        await table.save();
        console.log(`💾 handleGameAction: State saved to database with gameOver: ${table.gameState.gameOver}`);

        // Verify state consistency before emitting
        console.log(`🔍 EMIT_CONSISTENCY_CHECK: About to emit game_update`);
        console.log(`🔍 EMIT_CONSISTENCY_CHECK: Emitted state - gameOver: ${updatedState.gameOver}, gameStarted: ${updatedState.gameStarted}, currentTurn: ${updatedState.currentTurn}`);
        console.log(`🔍 EMIT_CONSISTENCY_CHECK: Emitted state - players: ${updatedState.players?.map(p => ({ username: p.username, isHuman: p.isHuman })).join(', ')}`);
        console.log(`🔍 EMIT_CONSISTENCY_CHECK: Emitted state - playerHands lengths: ${updatedState.playerHands?.map(h => h.length).join(', ')}`);
        console.log(`🔍 EMIT_CONSISTENCY_CHECK: Emitted state - playerSpreads lengths: ${updatedState.playerSpreads?.map(s => s.length).join(', ')}`);

        // ✅ ENHANCED STATE BROADCASTING: Send different events for React vs Unity per spec
        io.to(tableId).emit('game_update', {
            type: 'GAME_STATE_UPDATE',
            payload: updatedState,
            timestamp: Date.now(),
            sessionId: tableId
        });

        // Send Unity-specific events per communication protocol
        io.to(tableId).emit('unity_game_update', {
            type: 'GAME_STATE_UPDATE',
            payload: updatedState,
            timestamp: Date.now(),
            sessionId: tableId,
            gameOver: updatedState.gameOver,
            currentTurn: updatedState.currentTurn,
            players: updatedState.players
        });
        console.log(`📡 handleGameAction: Emitted enhanced game_update with gameOver: ${updatedState.gameOver}`);

        // ✅ CRITICAL FIX: Send turn start notification to Unity after action completes
        if (!updatedState.gameOver) {
            const nextPlayer = updatedState.players[updatedState.currentTurn];
            console.log(`🎯 TURN_START: Sending turn notification for player ${nextPlayer.username} (human: ${nextPlayer.isHuman})`);

            // Send turn start notification to all clients (including Unity)
            io.to(tableId).emit('turn_start', {
                playerUsername: nextPlayer.username,
                currentTurn: updatedState.currentTurn,
                isPlayerTurn: true,
                turnPhase: updatedState.hasDrawnCard ? 'action_phase' : 'draw_phase',
                gameState: updatedState,
                message: `${nextPlayer.username}, it's your turn!`,
                timestamp: Date.now()
            });

            // Send specific Unity event for turn management
            io.to(tableId).emit('unity_turn_start', {
                playerUsername: nextPlayer.username,
                currentTurn: updatedState.currentTurn,
                isPlayerTurn: true,
                turnPhase: updatedState.hasDrawnCard ? 'action_phase' : 'draw_phase',
                message: `${nextPlayer.username}, it's your turn!`
            });

            if (!nextPlayer.isHuman) {
                console.log(`🤖 handleGameAction: Delegating AI turn to GameStateManager for player ${nextPlayer.username}`);
                gameStateManagerInstance.handleAiTurn(tableId);
            } else {
                console.log(`👤 handleGameAction: Human player's turn - sent turn notification via Unity bridge`);
            }
        } else if (updatedState.gameOver) {
            console.log(`🏁 handleGameAction: Game ended, processing results...`);

            // Create game record first
            const gameRecord = new Game({
                tableId: tableId,
                players: updatedState.players.map(p => ({
                    playerId: null, // Will be updated when we find users
                    username: p.username,
                    isHuman: p.isHuman,
                    position: updatedState.players.indexOf(p),
                    initialBalance: 0, // Will be updated
                    finalBalance: 0 // Will be updated
                })),
                stake: updatedState.stake,
                status: 'completed',
                gameState: updatedState,
                startTime: new Date(),
                endTime: new Date(),
                winners: updatedState.winners.map(i => ({
                    playerId: null,
                    username: updatedState.players[i].username,
                    winType: updatedState.winType.toLowerCase().replace('_', '_'),
                    payout: 0 // Will be calculated
                })),
                roundScores: updatedState.roundScores.map((score, i) => ({
                    playerId: null,
                    username: updatedState.players[i].username,
                    score: score,
                    hand: updatedState.playerHands[i] || []
                }))
            });

            await gameRecord.save();
            console.log(`📝 Game record created: ${gameRecord._id}`);

            // Use atomic wagering service for all financial operations
            const wageringResult = await wageringService.distributeWinnings(
                updatedState.players,
                updatedState.winners,
                updatedState.winType,
                updatedState.stake,
                tableId,
                gameRecord._id
            );

            if (!wageringResult.success) {
                console.error(`💰 WAGERING_ERROR: ${wageringResult.error}`);
                // Game still ends, but log the error
                io.to(tableId).emit('error', {
                    message: 'Game completed but wagering error occurred. Please contact support.'
                });
            } else {
                console.log(`💰 WAGERING_SUCCESS: Distributed ${wageringResult.totalDistributed} in winnings`);
            }

            // Handle drop penalty if applicable
            if (updatedState.winType === 'DROP_CAUGHT' && updatedState.dropped !== undefined) {
                const dropPenaltyResult = await wageringService.processDropPenalty(
                    updatedState.players,
                    updatedState.dropped,
                    updatedState.roundScores,
                    updatedState.stake,
                    tableId,
                    gameRecord._id
                );

                if (!dropPenaltyResult.success) {
                    console.error(`💰 DROP_PENALTY_ERROR: ${dropPenaltyResult.error}`);
                } else {
                    console.log(`💰 DROP_PENALTY_SUCCESS: ${dropPenaltyResult.penaltyPaid} penalty processed`);
                }
            }

            // Update stats for all human players
            for (let i = 0; i < updatedState.players.length; i++) {
                const player = updatedState.players[i];
                if (!player.isHuman) continue;

                const user = await User.findOne({ username: player.username });
                if (!user) continue;

                let gameResult = 'loss';
                if (updatedState.winners.includes(i)) {
                    gameResult = updatedState.winType === 'REEM' ? 'reem' : 'win';
                }

                // Update stats
                if (!user.stats) {
                    user.stats = { gamesPlayed: 0, wins: 0, reemWins: 0, totalEarnings: 0 };
                }
                user.stats.gamesPlayed += 1;
                if (gameResult === 'win') user.stats.wins += 1;
                if (gameResult === 'reem') user.stats.reemWins += 1;

                // Add to game history (earnings will be calculated from transactions)
                user.gameHistory.push({
                    date: new Date(),
                    stake: updatedState.stake,
                    result: gameResult,
                    earnings: 0, // Will be updated from transaction data
                    opponents: updatedState.players.filter((p, idx) => idx !== i).map(p => p.username)
                });

                await user.save();
                console.log(`📊 Updated stats for ${player.username}: gamesPlayed=${user.stats.gamesPlayed}, wins=${user.stats.wins}, reemWins=${user.stats.reemWins}`);
            }

            // Emit game over event with final results
            io.to(tableId).emit('game_over', {
                winners: updatedState.winners,
                scores: updatedState.roundScores,
                winType: updatedState.winType,
                gameId: gameRecord._id,
                wageringSuccess: wageringResult.success
            });
        } else {
            console.log(`👤 handleGameAction: Next player is human, no AI turn scheduled`);
        }
    } catch (error) {
        console.error('Error processing game action:', error);
        socket.emit('error', { message: 'Failed to process game action.' });
    }
};

module.exports = {
    handleGameAction
};