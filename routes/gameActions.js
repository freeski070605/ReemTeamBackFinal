const { processGameAction } = require('../models/gameLogic');
const { runAiTurn } = require('../models/AiPlayer');
const { Table } = require('../models/Table');
const User = require('../models/User');

const GameStateManager = require('../utils/gameStateManager');

// ✅ TURN VALIDATION HELPER: Check if current player can act
const validateTurnAction = (gameState, socketId, action) => {
    // Check if game is active
    if (!gameState || gameState.gameOver) {
        console.log(`🚫 TURN_VALIDATION: Game over or not started - rejecting action ${action}`);
        return { valid: false, reason: 'Game not active' };
    }

    // Check turn ownership
    const currentPlayer = gameState.players[gameState.currentTurn];
    if (!currentPlayer || currentPlayer.socketId !== socketId) {
        console.log(`🚫 TURN_VALIDATION: Not player's turn - current: ${currentPlayer?.username}, socket: ${socketId}`);
        return { valid: false, reason: 'Not your turn' };
    }

    // Check action timing
    if (action === 'DRAW_CARD' && gameState.hasDrawnCard) {
        console.log(`🚫 TURN_VALIDATION: Already drawn card this turn`);
        return { valid: false, reason: 'Already drawn card' };
    }

    if ((action === 'DISCARD' || action === 'SPREAD' || action === 'HIT') && !gameState.hasDrawnCard) {
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

        // ✅ CRITICAL FIX: Add turn validation before processing action
        const turnValidation = validateTurnAction(table.gameState, socket.id, action);
        if (!turnValidation.valid) {
          console.log(`🚫 TURN_VALIDATION_FAILED: ${turnValidation.reason} for action ${action}`);
          console.log(`🔍 TURN_VALIDATION_DEBUG: Current state - Turn: ${table.gameState.currentTurn}, GameOver: ${table.gameState.gameOver}, HasDrawnCard: ${table.gameState.hasDrawnCard}`);
          console.log(`🔍 TURN_VALIDATION_DEBUG: Current player: ${currentPlayer?.username} (socket: ${currentPlayer?.socketId}), Requesting socket: ${socket.id}`);
    
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

        // Process action synchronously with additional logging
        console.log(`🔄 PROCESSING ACTION: ${action} with payload:`, JSON.stringify(payload));
        const updatedState = processGameAction(table.gameState, action, payload);
        console.log(`🎯 handleGameAction: After processing - gameOver: ${updatedState.gameOver}, winType: ${updatedState.winType}, winners: [${updatedState.winners?.join(',') || ''}]`);
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

        io.to(tableId).emit('game_update', updatedState);
        console.log(`📡 handleGameAction: Emitted game_update with gameOver: ${updatedState.gameOver}`);

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
            const { winners, winType, roundScores, stake, players } = updatedState;
            const pot = stake * players.length;

            for (let i = 0; i < players.length; i++) {
                const player = players[i];
                if (!player.isHuman) continue; // Skip AI players for chip/stat updates

                const user = await User.findOne({ username: player.username });
                if (!user) {
                    console.error(`User ${player.username} not found for stat update.`);
                    continue;
                }

                let earnings = 0;
                let gameResult = 'loss';

                if (winners.includes(i)) {
                    // Winner logic
                    gameResult = 'win';
                    if (winType === 'REEM') {
                        earnings = pot; // REEM winner takes the whole pot
                        gameResult = 'reem';
                    } else if (winType === 'DROP_WIN') {
                        earnings = pot; // Drop winner takes the whole pot
                        gameResult = 'win';
                    } else if (winType === 'IMMEDIATE_50_WIN') {
                        earnings = pot * 2; // Immediate 50 win gets double payout
                        gameResult = 'win'; // Still a 'win' for stats
                    } else if (winType === 'SPECIAL_WIN') {
                        earnings = pot * 3; // Special win (41 or under 11) gets triple payout
                        gameResult = 'win'; // Still a 'win' for stats
                    } else {
                        // Regular win or STOCK_EMPTY win, split pot among winners
                        earnings = pot / winners.length;
                    }
                    user.chips += earnings;
                } else {
                    // Loser logic (stake already deducted at game start)
                    earnings = -stake; // Represent loss as negative earnings
                }

                // Update user stats
                if (!user.stats) {
                    user.stats = { gamesPlayed: 0, wins: 0, reemWins: 0, totalEarnings: 0 };
                }
                user.stats.gamesPlayed += 1;
                if (gameResult === 'win') user.stats.wins += 1;
                if (gameResult === 'reem') user.stats.reemWins += 1;
                user.stats.totalEarnings += earnings;

                // Add to game history
                user.gameHistory.push({
                    date: new Date(),
                    stake: stake,
                    result: gameResult,
                    earnings: earnings,
                    opponents: players.filter((p, idx) => idx !== i).map(p => p.username)
                });

                await user.save();
                console.log(`📊 Updated stats for ${player.username}: gamesPlayed=${user.stats.gamesPlayed}, wins=${user.stats.wins}, reemWins=${user.stats.reemWins}, totalEarnings=${user.stats.totalEarnings}, chips=${user.chips}`);
            }

            io.to(tableId).emit('game_over', {
                winners: updatedState.winners,
                scores: updatedState.roundScores,
                winType: updatedState.winType
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
