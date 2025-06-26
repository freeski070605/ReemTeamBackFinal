const GameSync = {
    broadcastGameState: (wsServer, table) => {
        const gameState = {
            type: 'GAME_UPDATE',
            table: {
                ...table,
                playerHands: table.playerHands.map((hand, idx) => 
                    idx === table.currentTurn ? hand : hand.length
                )
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
    }
};
