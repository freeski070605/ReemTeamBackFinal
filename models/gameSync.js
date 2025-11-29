const GameSync = {
    broadcastGameState: (wsServer, table) => {
        const gameState = {
            type: 'GAME_UPDATE',
            table: {
                ...table,
                playerHands: table.playerHands ? table.playerHands.map((hand, idx) =>
                    idx === table.currentTurn ? hand : hand.length
                ) : []
            }
        };

        wsServer.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                const playerView = GameSync.getPlayerView(gameState, client.userId);
                client.send(JSON.stringify(playerView));
            }
        });
    },

    handleDisconnect: async (table, playerId) => {
        // Save game state
        await GameSync.saveGameState(table);

        // Handle disconnection based on game state
        if (table.gameStarted && !table.gameOver) {
            return GameSync.pauseGame(table);
        }
        return GameSync.removePlayer(table, playerId);
    },

    getPlayerView: (gameState, userId) => {
        // Return a view of the game state specific to the player
        // Hide other players' full hands, etc.
        const view = { ...gameState };
        // Implementation depends on game rules
        return view;
    },

    saveGameState: async (table) => {
        // Save current game state to database
        // This would update the Table document with current state
        await table.save();
    },

    pauseGame: (table) => {
        // Mark game as paused due to disconnection
        table.status = 'paused';
        return table;
    },

    removePlayer: (table, playerId) => {
        // Remove player from table
        table.players = table.players.filter(p => p._id !== playerId);
        return table;
    },

    validateState: (table, incomingState) => {
        // Validate incoming game state against current state
        // Check for consistency, prevent cheating, etc.
        return true; // Placeholder
    },

    synchronizeState: (io, tableId, table) => {
        // Broadcast full state synchronization to all clients in the room
        io.to(tableId).emit('state_sync', {
            table,
            timestamp: Date.now(),
            version: table.stateVersion || 0
        });
    }
};

// Export individual functions for use in other modules
const broadcastGameState = (io, table) => {
    const gameState = {
        type: 'GAME_UPDATE',
        table: {
            ...table.toObject(),
            playerHands: table.playerHands ? table.playerHands.map((hand, idx) =>
                idx === table.currentTurn ? hand : hand.length
            ) : []
        },
        timestamp: Date.now()
    };

    io.to(table.tableId).emit('game_update', gameState);
};

const synchronizeGameState = (io, tableId, table) => {
    GameSync.synchronizeState(io, tableId, table);
};
