const { processGameAction } = require('../models/gameLogic');
const { runAiTurn } = require('../models/AiPlayer');
const { Table } = require('../models/Table');
const User = require('../models/User'); // Import User model

const GameStateManager = require('../utils/gameStateManager');
const handleGameAction = async (io, socket, { tableId, action, payload }, gameStateManagerInstance) => {
    try {
        console.log(`🎯 handleGameAction: ${action} from socket ${socket.id} at table ${tableId}`);
        
        const table = await Table.findById(tableId);
        if (!table || !table.gameState) {
            socket.emit('error', { message: 'Table or game state not found.' });
            return;
        }

        const currentPlayer = table.gameState.players[table.gameState.currentTurn];
        console.log(`🎯 handleGameAction: Current player: ${currentPlayer.username} (socketId: ${currentPlayer.socketId}), Action from: ${socket.id}`);
        
        if (currentPlayer.socketId !== socket.id) {
            socket.emit('error', { message: 'Not your turn.' });
            return;
        }

        console.log(`🎯 handleGameAction: Before processing - gameOver: ${table.gameState.gameOver}`);
        const updatedState = processGameAction(table.gameState, action, payload);
        console.log(`🎯 handleGameAction: After processing - gameOver: ${updatedState.gameOver}, winType: ${updatedState.winType}, winners: [${updatedState.winners?.join(',') || ''}]`);

        console.log(`📝 handleGameAction: About to assign updatedState with gameOver: ${updatedState.gameOver}`);
        table.gameState = updatedState;
        await table.save();
        console.log(`💾 handleGameAction: State saved to database with gameOver: ${table.gameState.gameOver}`);

        io.to(tableId).emit('game_update', updatedState);
        console.log(`📡 handleGameAction: Emitted game_update with gameOver: ${updatedState.gameOver}`);

        if (!updatedState.gameOver && !updatedState.players[updatedState.currentTurn].isHuman) {
            console.log(`🤖 handleGameAction: Delegating AI turn to GameStateManager for player ${updatedState.players[updatedState.currentTurn].username}`);
            gameStateManagerInstance.handleAiTurn(tableId);
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