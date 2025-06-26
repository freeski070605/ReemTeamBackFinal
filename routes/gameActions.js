const { processGameAction } = require('../models/gameLogic');
const { runAiTurn } = require('../models/AiPlayer');
const { Table } = require('../models/Table');

const GameStateManager = require('../utils/gameStateManager');
let gameStateManager = null;

const handleGameAction = async (io, socket, { tableId, action, payload }) => {
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
            console.log(`🤖 handleGameAction: Scheduling AI turn for player ${updatedState.players[updatedState.currentTurn].username}`);
            setTimeout(async () => {
                const updatedTable = await Table.findById(tableId);
                console.log(`🤖 handleGameAction: Retrieved table for AI turn - gameOver: ${updatedTable.gameState.gameOver}`);
                const aiState = runAiTurn(updatedTable.gameState);
                console.log(`🤖 handleGameAction: AI turn complete - gameOver: ${aiState.gameOver}, winType: ${aiState.winType}, winners: [${aiState.winners?.join(',') || ''}]`);
                updatedTable.gameState = aiState;
                await updatedTable.save();
                console.log(`💾 handleGameAction: AI state saved to database`);
                io.to(tableId).emit('game_update', aiState);
                console.log(`📡 handleGameAction: Emitted AI game_update with gameOver: ${aiState.gameOver}`);
            }, 800);
        } else if (updatedState.gameOver) {
            console.log(`🏁 handleGameAction: Game ended, no AI turn scheduled`);
            io.to(tableId).emit('game_over', {
                winners: updatedState.winners,
                scores: updatedState.roundScores, // or appropriate score array
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