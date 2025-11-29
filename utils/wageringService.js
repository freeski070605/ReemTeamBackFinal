const mongoose = require('mongoose');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { v4: uuidv4 } = require('uuid');

class WageringService {
    /**
     * Distribute winnings to players using atomic MongoDB transactions
     * @param {Array} players - Array of player objects from game state
     * @param {Array} winners - Array of winner indices
     * @param {string} winType - Type of win (REEM, IMMEDIATE_50_WIN, etc.)
     * @param {number} stake - Game stake amount
     * @param {string} tableId - Table ID
     * @param {string} gameId - Game record ID
     * @returns {Promise<Object>} Result with success status and details
     */
    async distributeWinnings(players, winners, winType, stake, tableId, gameId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            console.log(`💰 Starting wagering transaction for ${players.length} players, winners: [${winners.join(',')}], type: ${winType}, stake: ${stake}`);

            const pot = stake * players.length;
            const transactions = [];
            let totalDistributed = 0;

            // Process each human player
            for (let i = 0; i < players.length; i++) {
                const player = players[i];
                if (!player.isHuman) continue;

                const user = await User.findOne({ username: player.username }).session(session);
                if (!user) {
                    throw new Error(`User ${player.username} not found`);
                }

                let payout = 0;
                let multiplier = 1;
                let description = '';
                let transactionType = 'WINNINGS';

                if (winners.includes(i)) {
                    // Winner calculations
                    switch (winType) {
                        case 'REEM':
                            payout = pot;
                            multiplier = 2; // Double stake payout
                            description = `REEM win - collected entire pot of $${pot}`;
                            break;
                        case 'IMMEDIATE_50_WIN':
                            payout = pot * 2;
                            multiplier = 2;
                            description = `Immediate 50-point win - double payout of $${pot * 2}`;
                            break;
                        case 'SPECIAL_WIN':
                            payout = pot * 3;
                            multiplier = 3;
                            description = `Special milestone win (41 or ≤11 points) - triple payout of $${pot * 3}`;
                            break;
                        case 'DROP_WIN':
                            payout = pot;
                            multiplier = 1;
                            description = `Drop win - collected entire pot of $${pot}`;
                            break;
                        default:
                            // Regular win or STOCK_EMPTY win - split among winners
                            payout = pot / winners.length;
                            multiplier = 1;
                            description = `Regular win - split pot $${payout.toFixed(2)} of $${pot}`;
                            break;
                    }
                } else {
                    // Losers get nothing additional (stake already deducted at game start)
                    payout = 0;
                    description = `Game loss - stake of $${stake} already deducted`;
                    transactionType = 'WINNINGS'; // Still record as winnings transaction
                }

                // Create transaction record
                const transactionId = `txn_${uuidv4()}`;
                const transaction = new Transaction({
                    playerId: user._id,
                    username: user.username,
                    gameId: gameId,
                    tableId: tableId,
                    type: transactionType,
                    amount: payout,
                    balanceBefore: user.cashBalance,
                    balanceAfter: user.cashBalance + payout,
                    description: description,
                    winType: winType.toLowerCase().replace('_', '_'),
                    stake: stake,
                    multiplier: multiplier,
                    status: 'completed',
                    transactionId: transactionId
                });

                // Update user balance
                user.cashBalance += payout;

                // Log transaction in user's transaction history
                if (!user.transactions) {
                    user.transactions = [];
                }
                user.transactions.push({
                    amount: payout,
                    type: transactionType === 'WINNINGS' ? (payout > 0 ? 'WIN' : 'LOSS') : transactionType,
                    gameId: gameId.toString(),
                    reason: description,
                    transactionId: transactionId,
                    timestamp: new Date()
                });

                // Update game history earnings
                const latestGameHistory = user.gameHistory[user.gameHistory.length - 1];
                if (latestGameHistory && latestGameHistory.earnings === 0) {
                    latestGameHistory.earnings = payout;
                }

                await transaction.save({ session });
                await user.save({ session });

                transactions.push(transaction);
                totalDistributed += payout;

                console.log(`💰 Player ${user.username}: ${description}, balance: $${user.cashBalance}`);
            }

            // Commit the transaction
            await session.commitTransaction();
            console.log(`💰 Wagering transaction completed successfully. Total distributed: $${totalDistributed}`);

            return {
                success: true,
                totalDistributed,
                transactionsCount: transactions.length,
                pot,
                winnersCount: winners.length
            };

        } catch (error) {
            // Rollback transaction on error
            await session.abortTransaction();
            console.error(`💰 Wagering transaction failed: ${error.message}`, error);

            // Attempt to mark any partial transactions as failed
            try {
                await Transaction.updateMany(
                    { gameId: gameId, status: 'pending' },
                    { status: 'failed' }
                );
            } catch (rollbackError) {
                console.error('Failed to rollback partial transactions:', rollbackError);
            }

            return {
                success: false,
                error: error.message,
                totalDistributed: 0
            };
        } finally {
            session.endSession();
        }
    }

    /**
     * Process drop penalty for players who drop with higher scores
     * @param {Array} players - Array of player objects
     * @param {number} dropperIndex - Index of the player who dropped
     * @param {Array} roundScores - Final scores for all players
     * @param {number} stake - Game stake amount
     * @param {string} tableId - Table ID
     * @param {string} gameId - Game record ID
     */
    async processDropPenalty(players, dropperIndex, roundScores, stake, tableId, gameId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            console.log(`💰 Processing drop penalty for player ${players[dropperIndex].username}`);

            const dropper = players[dropperIndex];
            const dropperScore = roundScores[dropperIndex];
            let penaltyPaid = 0;

            // Find players with lower scores (winners)
            const winners = roundScores
                .map((score, index) => ({ score, index }))
                .filter(({ score }) => score < dropperScore)
                .map(({ index }) => players[index]);

            if (winners.length === 0) {
                console.log(`💰 No drop penalty - dropper had the lowest score`);
                await session.commitTransaction();
                return { success: true, penaltyPaid: 0 };
            }

            // Process penalty payment to each winner
            for (const winner of winners) {
                if (!winner.isHuman) continue;

                const winnerUser = await User.findOne({ username: winner.username }).session(session);
                const dropperUser = await User.findOne({ username: dropper.username }).session(session);

                if (!winnerUser || !dropperUser) {
                    throw new Error(`User not found: ${winner.username} or ${dropper.username}`);
                }

                // Transfer stake from dropper to winner
                dropperUser.cashBalance -= stake;
                winnerUser.cashBalance += stake;
                penaltyPaid += stake;

                // Create transaction records
                const dropperTxnId = `txn_${uuidv4()}`;
                const winnerTxnId = `txn_${uuidv4()}`;

                const dropperTransaction = new Transaction({
                    playerId: dropperUser._id,
                    username: dropperUser.username,
                    gameId: gameId,
                    tableId: tableId,
                    type: 'PENALTY',
                    amount: -stake,
                    balanceBefore: dropperUser.cashBalance + stake,
                    balanceAfter: dropperUser.cashBalance,
                    description: `Drop penalty paid to ${winner.username} (score ${dropperScore} vs ${roundScores[players.indexOf(winner)]})`,
                    winType: 'drop_penalty',
                    stake: stake,
                    status: 'completed',
                    transactionId: dropperTxnId
                });

                const winnerTransaction = new Transaction({
                    playerId: winnerUser._id,
                    username: winnerUser.username,
                    gameId: gameId,
                    tableId: tableId,
                    type: 'WINNINGS',
                    amount: stake,
                    balanceBefore: winnerUser.cashBalance - stake,
                    balanceAfter: winnerUser.cashBalance,
                    description: `Drop penalty collected from ${dropper.username}`,
                    winType: 'drop_penalty',
                    stake: stake,
                    status: 'completed',
                    transactionId: winnerTxnId
                });

                // Log in user transaction history
                dropperUser.transactions.push({
                    amount: -stake,
                    type: 'LOSS',
                    gameId: gameId.toString(),
                    reason: `Drop penalty to ${winner.username}`,
                    transactionId: dropperTxnId,
                    timestamp: new Date()
                });

                winnerUser.transactions.push({
                    amount: stake,
                    type: 'WIN',
                    gameId: gameId.toString(),
                    reason: `Drop penalty from ${dropper.username}`,
                    transactionId: winnerTxnId,
                    timestamp: new Date()
                });

                await dropperTransaction.save({ session });
                await winnerTransaction.save({ session });
                await dropperUser.save({ session });
                await winnerUser.save({ session });

                console.log(`💰 Drop penalty: ${dropperUser.username} paid $${stake} to ${winnerUser.username}`);
            }

            await session.commitTransaction();
            console.log(`💰 Drop penalty processed successfully. Total penalty: $${penaltyPaid}`);

            return {
                success: true,
                penaltyPaid,
                winnersCount: winners.length
            };

        } catch (error) {
            await session.abortTransaction();
            console.error(`💰 Drop penalty transaction failed: ${error.message}`, error);

            return {
                success: false,
                error: error.message,
                penaltyPaid: 0
            };
        } finally {
            session.endSession();
        }
    }

    /**
     * Deduct initial stakes when game starts
     * @param {Array} players - Array of player objects
     * @param {number} stake - Stake amount per player
     * @param {string} tableId - Table ID
     * @returns {Promise<Object>} Result with success status
     */
    async deductInitialStakes(players, stake, tableId) {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            console.log(`💰 Deducting initial stakes for ${players.length} players, stake: $${stake}`);

            const transactions = [];

            for (const player of players) {
                if (!player.isHuman) continue;

                const user = await User.findOne({ username: player.username }).session(session);
                if (!user) {
                    throw new Error(`User ${player.username} not found`);
                }

                if (user.cashBalance < stake) {
                    throw new Error(`Insufficient balance for ${player.username}: has $${user.cashBalance}, needs $${stake}`);
                }

                const transactionId = `stake_${uuidv4()}`;
                const transaction = new Transaction({
                    playerId: user._id,
                    username: user.username,
                    tableId: tableId,
                    type: 'STAKE_DEDUCTION',
                    amount: -stake,
                    balanceBefore: user.cashBalance,
                    balanceAfter: user.cashBalance - stake,
                    description: `Initial stake deduction for game start`,
                    stake: stake,
                    status: 'completed',
                    transactionId: transactionId
                });

                user.cashBalance -= stake;

                user.transactions.push({
                    amount: -stake,
                    type: 'LOSS',
                    gameId: null, // Will be updated when game starts
                    reason: 'Game Start Stake',
                    transactionId: transactionId,
                    timestamp: new Date()
                });

                await transaction.save({ session });
                await user.save({ session });

                transactions.push(transaction);
                console.log(`💰 Stake deducted from ${user.username}: $${stake}, balance: $${user.cashBalance}`);
            }

            await session.commitTransaction();
            console.log(`💰 Initial stakes deducted successfully for ${transactions.length} players`);

            return {
                success: true,
                totalStaked: transactions.length * stake,
                playersCount: transactions.length
            };

        } catch (error) {
            await session.abortTransaction();
            console.error(`💰 Stake deduction failed: ${error.message}`, error);

            // Mark failed transactions
            try {
                await Transaction.updateMany(
                    { tableId: tableId, type: 'STAKE_DEDUCTION', status: 'pending' },
                    { status: 'failed' }
                );
            } catch (rollbackError) {
                console.error('Failed to rollback stake deductions:', rollbackError);
            }

            return {
                success: false,
                error: error.message
            };
        } finally {
            session.endSession();
        }
    }

    /**
     * Get transaction history for a player
     * @param {string} playerId - Player ID
     * @param {Object} options - Query options (limit, skip, etc.)
     * @returns {Promise<Array>} Transaction history
     */
    async getTransactionHistory(playerId, options = {}) {
        const { limit = 50, skip = 0, type, gameId } = options;

        const query = { playerId };
        if (type) query.type = type;
        if (gameId) query.gameId = gameId;

        return await Transaction.find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .skip(skip)
            .populate('gameId', 'stake status')
            .lean();
    }

    /**
     * Get player's current balance
     * @param {string} username - Player username
     * @returns {Promise<number>} Current balance
     */
    async getPlayerBalance(username) {
        const user = await User.findOne({ username }).select('cashBalance');
        return user ? user.cashBalance : 0;
    }
}

module.exports = new WageringService();