const colyseus = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

const {
    createDeck,
    shuffleDeck,
    dealHands,
    calculatePoints,
    isValidSpread,
    isValidHit,
    initializeGameState: coreInitializeGameState,
    processGameAction,
    calculateStateHash,
    findBestSpread,
    findBestHit,
} = require('../models/gameLogic');

const { runAiTurn } = require('../models/AiPlayer');
const { Table } = require('../models/Table');
const User = require('../models/User');

// === Schema Definitions ===
class Card extends Schema {
    constructor(rank, suit) {
        super();
        this.rank = rank;
        this.suit = suit;
    }
}
type("string")(Card.prototype, "rank");
type("string")(Card.prototype, "suit");

class Player extends Schema {
    constructor(username, chips, isHuman, sessionId) {
        super();
        this.username = username;
        this.chips = chips;
        this.isHuman = isHuman;
        this.sessionId = sessionId;
        this.joinedAt = Date.now();
        this.status = 'active';
        this.hitPenaltyRounds = 0;
        this.hitCount = 0;
    }
}
type("string")(Player.prototype, "username");
type("number")(Player.prototype, "chips");
type("boolean")(Player.prototype, "isHuman");
type("string")(Player.prototype, "sessionId");
type("number")(Player.prototype, "joinedAt");
type("string")(Player.prototype, "status");
type("number")(Player.prototype, "hitPenaltyRounds");
type("number")(Player.prototype, "hitCount");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new ArraySchema();
        this.playerHands = new ArraySchema();
        this.playerSpreads = new ArraySchema();
        this.deck = new ArraySchema();
        this.discardPile = new ArraySchema();
        this.currentTurn = 0;
        this.hasDrawnCard = false;
        this.gameStarted = false;
        this.gameOver = false;
        this.winners = new ArraySchema();
        this.winType = "";
        this.roundScores = new ArraySchema();
        this.stake = 0;
        this.caught = null;
        this.gameEndMessage = "";
        this.gameEndReason = "";
        this.chipBalances = new MapSchema();
        this.isInitialized = false;
        this.isLoading = true;
        this.connectionStatus = 'disconnected';
        this.error = null;
        this.lastUpdateTime = Date.now();
        this.playerPosition = -1;
        this.isMultiplayer = false;
        this.timestamp = Date.now();
        this.gameStartingCountdown = 0;
        this.message = "";
        this.spectators = new ArraySchema();
        this.readyPlayers = new ArraySchema();
        this.pot = 0;
    }
}
type([Player])(GameState.prototype, "players");
type([[Card]])(GameState.prototype, "playerHands");
type([[[Card]]])(GameState.prototype, "playerSpreads");
type([Card])(GameState.prototype, "deck");
type([Card])(GameState.prototype, "discardPile");
type("number")(GameState.prototype, "currentTurn");
type("boolean")(GameState.prototype, "hasDrawnCard");
type("boolean")(GameState.prototype, "gameStarted");
type("boolean")(GameState.prototype, "gameOver");
type(["number"])(GameState.prototype, "winners");
type("string")(GameState.prototype, "winType");
type(["number"])(GameState.prototype, "roundScores");
type("number")(GameState.prototype, "stake");
type("string")(GameState.prototype, "caught");
type("string")(GameState.prototype, "gameEndMessage");
type("string")(GameState.prototype, "gameEndReason");
type({ map: "number" })(GameState.prototype, "chipBalances");
type("boolean")(GameState.prototype, "isInitialized");
type("boolean")(GameState.prototype, "isLoading");
type("string")(GameState.prototype, "connectionStatus");
type("string")(GameState.prototype, "error");
type("number")(GameState.prototype, "lastUpdateTime");
type("number")(GameState.prototype, "playerPosition");
type("boolean")(GameState.prototype, "isMultiplayer");
type("number")(GameState.prototype, "timestamp");
type("number")(GameState.prototype, "gameStartingCountdown");
type("string")(GameState.prototype, "message");
type([Player])(GameState.prototype, "spectators");
type(["string"])(GameState.prototype, "readyPlayers");
type("number")(GameState.prototype, "pot");



class GameRoom extends colyseus.Room {
    constructor() {
        super();
        this.maxClients = 4; // Max players in a room
        this.autoDispose = false; // Keep room alive even if empty for a bit
        this.setPatchRate(1000 / 20); // 20 FPS patch rate
        this.setSimulationInterval(this.update.bind(this), 1000); // 1 second update for game logic
        this.gameLoopInterval = null;
        this.countdownInterval = null;
        this.tableDb = null; // Reference to the MongoDB Table document
    }

    async onCreate(options) {
        console.log(`[GameRoom ${this.roomId}] created with options:`, options);
        this.setState(new GameState());

        // Load table from DB
        // When a room is created via matchMaker.joinOrCreate, the `options` will contain
        // the `stake` from the room name (e.g., 'tonk_5' -> stake: 5).
        // We need to find or create a Table document in MongoDB based on this stake.
        const stake = options.stake;
        if (!stake) {
            throw new Error("Stake not provided in room options. Cannot create room.");
        }

        // Try to find an existing table for this stake that is not full
        this.tableDb = await Table.findOne({ stake: stake, 'players.length': { $lt: 4 } });

        if (!this.tableDb) {
            // If no suitable table exists, create a new one
            console.log(`[GameRoom ${this.roomId}] No existing table for stake $${stake} found. Creating a new one.`);
            this.tableDb = new Table({
                name: `Tonk Table $${stake}`,
                stake: stake,
                players: [],
                status: 'waiting',
                spectators: [],
                readyPlayers: []
            });
            await this.tableDb.save();
            console.log(`[GameRoom ${this.roomId}] Created new table in DB: ${this.tableDb._id} for stake $${stake}`);
        } else {
            console.log(`[GameRoom ${this.roomId}] Found existing table in DB: ${this.tableDb._id} for stake $${stake}`);
        }

        // Initialize Colyseus state from DB table state if available
        if (this.tableDb.gameState) {
            Object.assign(this.state, this.tableDb.gameState);
            // Convert plain objects back to Schema types if necessary
            this.state.players = new ArraySchema(...this.tableDb.gameState.players.map(p => new Player(p.username, p.chips, p.isHuman, p.sessionId || p.socketId)));
            this.state.playerHands = new ArraySchema(...this.tableDb.gameState.playerHands.map(hand => new ArraySchema(...hand.map(card => new Card(card.rank, card.suit)))));
            this.state.playerSpreads = new ArraySchema(...this.tableDb.gameState.playerSpreads.map(playerSpreads => new ArraySchema(...playerSpreads.map(spread => new ArraySchema(...spread.map(card => new Card(card.rank, card.suit)))))));
            this.state.deck = new ArraySchema(...this.tableDb.gameState.deck.map(card => new Card(card.rank, card.suit)));
            this.state.discardPile = new ArraySchema(...this.tableDb.gameState.discardPile.map(card => new Card(card.rank, card.suit)));
            this.state.winners = new ArraySchema(...this.tableDb.gameState.winners);
            this.state.roundScores = new ArraySchema(...this.tableDb.gameState.roundScores);
            this.state.chipBalances = new MapSchema(this.tableDb.gameState.chipBalances);
            this.state.readyPlayers = new ArraySchema(...this.tableDb.gameState.readyPlayers);
            this.state.stake = this.tableDb.stake;
            this.state.pot = this.tableDb.stake * this.state.players.length;
            this.state.isInitialized = true;
            this.state.isLoading = false;
            this.state.connectionStatus = 'connected';
            this.state.timestamp = Date.now();
        } else {
            this.state.stake = this.tableDb.stake;
            this.state.isInitialized = true;
            this.state.isLoading = false;
            this.state.connectionStatus = 'connected';
        }

        // Set up message handlers
        this.onMessage("game_action", this.handleGameAction.bind(this));
        this.onMessage("request_state_sync", (client) => {
            console.log(`Received request_state_sync from ${client.sessionId}`);
            client.send("state_sync", this.state.toJSON()); // Send a JSON representation
        });
        this.onMessage("player_ready", this.handlePlayerReady.bind(this));
    }

    async onJoin(client, options) {
        console.log(`[GameRoom ${this.roomId}] ${client.sessionId} (${options.username}) joined the room! Options:`, options);

        // Check if player is already in the room (reconnection)
        const { username, chips, stake } = options;

        // 1. Check for reconnection
        const existingPlayerInState = this.state.players.find(p => p.sessionId === client.sessionId);
        if (existingPlayerInState) {
            existingPlayerInState.status = 'active';
            console.log(`[GameRoom ${this.roomId}] Player ${existingPlayerInState.username} reconnected.`);
            this.broadcast("player_reconnected", {
                sessionId: client.sessionId,
                username: existingPlayerInState.username,
                players: this.state.players.toJSON()
            });
            client.send("state_sync", this.state.toJSON());
            return;
        }

        // 2. Check if player is already in the DB table (e.g., joined from lobby, then reconnected)
        let playerInDb = this.tableDb.players.find(p => p.username === username);

        if (playerInDb) {
            // Player exists in DB table, update their session ID and status
            playerInDb.socketId = client.sessionId;
            playerInDb.status = 'active';
            playerInDb.chips = chips; // Update chips in DB as well
            console.log(`[GameRoom ${this.roomId}] Updated existing player in DB: ${username}`);

            // Find and update the player in Colyseus state if they exist there
            const playerInState = this.state.players.find(p => p.username === username);
            if (playerInState) {
                playerInState.assign({
                    sessionId: client.sessionId,
                    status: 'active',
                    chips: chips
                });
                console.log(`[GameRoom ${this.roomId}] Updated existing player in Colyseus state: ${username}`);
            } else {
                // This case should ideally not happen if DB and state are in sync,
                // but if it does, add them to state.
                const newPlayer = new Player(username, chips, true, client.sessionId);
                this.state.players.push(newPlayer);
                this.state.chipBalances.set(username, chips);
                console.log(`[GameRoom ${this.roomId}] Added existing DB player to Colyseus state: ${username}`);
            }

        } else {
            // New player joining the table for the first time
            console.log(`[GameRoom ${this.roomId}] Adding new player to DB and state: ${username}`);
            const newPlayer = new Player(username, chips, true, client.sessionId);
            this.state.players.push(newPlayer);
            this.state.chipBalances.set(username, chips);

            this.tableDb.players.push({
                username: username,
                chips: chips,
                isHuman: true,
                socketId: client.sessionId,
                joinedAt: new Date(),
                status: 'active'
            });
        }

        await this.tableDb.save();

        // Notify all clients about the new player
        this.broadcast("player_joined", {
            sessionId: client.sessionId,
            username: username,
            players: this.state.players.toJSON()
        });

        // Send initial state to the joining client
        client.send("state_sync", this.state.toJSON());
        console.log(`[GameRoom ${this.roomId}] Sent initial state to ${username}`);

        // Check if game can start
        this.checkAndStartGame();
    }

    async onLeave(client, consented) {
        console.log(`${client.sessionId} (${client.username || 'unknown'}) left the room! Consented: ${consented}`);

        // Mark client as inactive for a grace period
        const playerInState = this.state.players.find(p => p.sessionId === client.sessionId);
        if (playerInState) {
            playerInState.status = 'disconnected';
            console.log(`Player ${playerInState.username} marked as disconnected.`);
        }

        // Update DB table player status
        const playerInDb = this.tableDb.players.find(p => p.socketId === client.sessionId);
        if (playerInDb) {
            playerInDb.status = 'disconnected';
            await this.tableDb.save();
        }

        try {
            if (consented) {
                throw new Error("consented leave");
            }

            console.log("awaiting reconnection for", client.sessionId);
            await this.allowReconnection(client, 20); // 20 seconds grace period

            // If reconnected, update status
            const reconnectedPlayer = this.state.players.find(p => p.sessionId === client.sessionId);
            if (reconnectedPlayer) {
                reconnectedPlayer.status = 'active';
                console.log(`Player ${reconnectedPlayer.username} reconnected.`);
                this.broadcast("player_reconnected", {
                    sessionId: client.sessionId,
                    username: reconnectedPlayer.username,
                    players: this.state.players.toJSON()
                });
                // Update DB table player status
                const reconnectedPlayerInDb = this.tableDb.players.find(p => p.socketId === client.sessionId);
                if (reconnectedPlayerInDb) {
                    reconnectedPlayerInDb.status = 'active';
                    await this.tableDb.save();
                }
            }

        } catch (e) {
            console.log(`${client.sessionId} couldn't reconnect. Removing.`);
            // Remove player from state
            this.state.players = this.state.players.filter(p => p.sessionId !== client.sessionId);
            // Also remove from chipBalances map
            const usernameToRemove = playerInState ? playerInState.username : null;
            if (usernameToRemove && this.state.chipBalances.has(usernameToRemove)) {
                this.state.chipBalances.delete(usernameToRemove);
            }

            // Remove from DB table players
            this.tableDb.players = this.tableDb.players.filter(p => p.socketId !== client.sessionId);
            await this.tableDb.save();

            this.broadcast("player_left", {
                sessionId: client.sessionId,
                username: usernameToRemove || client.sessionId,
                players: this.state.players.toJSON()
            });

            // If the current player left, advance turn or end game
            if (this.state.players.length > 0 && this.state.currentTurn >= this.state.players.length) {
                this.state.currentTurn = 0; // Reset turn if current player was removed
            }
            if (this.state.players.length < 2 && this.state.gameStarted) {
                this.endGameDueToInsufficientPlayers();
            }
        }
    }

    onDispose() {
        console.log("GameRoom disposed!");
        if (this.gameLoopInterval) {
            clearInterval(this.gameLoopInterval);
        }
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
    }

    update(deltaTime) {
        // This method is called at the simulation interval (1 second in this case)
        // Use this for game logic that doesn't need high frequency updates,
        // like checking for game start conditions, AI turns, or cleanup.

        this.state.timestamp = Date.now(); // Update timestamp to trigger client updates

        // If game is not started and we have enough players, start countdown
        if (!this.state.gameStarted && this.state.players.length >= 2 && !this.countdownInterval) {
            this.startCountdown();
        }

        // If it's AI's turn and game is not over, run AI turn
        if (this.state.gameStarted && !this.state.gameOver && this.state.players.length > 0) {
            const currentPlayer = this.state.players[this.state.currentTurn];
            if (currentPlayer && !currentPlayer.isHuman) {
                this.handleAiTurn();
            }
        }
    }

    async handleGameAction(client, message) {
        console.log(`🎯 handleGameAction: ${message.action} from ${client.sessionId}`);

        if (this.state.gameOver) {
            client.send('error', { message: 'Game is already over.' });
            return;
        }

        const currentPlayer = this.state.players[this.state.currentTurn];
        if (!currentPlayer || currentPlayer.sessionId !== client.sessionId) {
            client.send('error', { message: 'Not your turn or you are not a player.' });
            return;
        }

        // Convert Colyseus Schema objects to plain JS objects for gameLogic functions
        const plainState = this.state.toJSON();
        plainState.playerHands = plainState.playerHands.map(hand => hand.map(card => ({ ...card })));
        plainState.playerSpreads = plainState.playerSpreads.map(playerSpreads => playerSpreads.map(spread => spread.map(card => ({ ...card }))));
        plainState.deck = plainState.deck.map(card => ({ ...card }));
        plainState.discardPile = plainState.discardPile.map(card => ({ ...card }));
        plainState.players = plainState.players.map(p => ({ ...p }));

        const updatedState = processGameAction(plainState, message.action, message.payload);

        // Update Colyseus state from the processed state
        this.state.assign({
            deck: new ArraySchema(...updatedState.deck.map(card => new Card(card.rank, card.suit))),
            discardPile: new ArraySchema(...updatedState.discardPile.map(card => new Card(card.rank, card.suit))),
            currentTurn: updatedState.currentTurn,
            hasDrawnCard: updatedState.hasDrawnCard,
            gameOver: updatedState.gameOver,
            gameStarted: updatedState.gameStarted,
            winners: new ArraySchema(...updatedState.winners),
            winType: updatedState.winType,
            roundScores: new ArraySchema(...updatedState.roundScores),
            caught: updatedState.caught,
            gameEndMessage: updatedState.gameEndMessage,
            gameEndReason: updatedState.gameEndReason,
            pot: updatedState.pot,
            timestamp: Date.now()
        });

        // Update playerHands and playerSpreads carefully as they are nested ArraySchemas
        this.state.playerHands.splice(0, this.state.playerHands.length); // Clear existing
        updatedState.playerHands.forEach(hand => {
            this.state.playerHands.push(new ArraySchema(...hand.map(card => new Card(card.rank, card.suit))));
        });

        this.state.playerSpreads.splice(0, this.state.playerSpreads.length); // Clear existing
        updatedState.playerSpreads.forEach(playerSpreads => {
            this.state.playerSpreads.push(new ArraySchema(...playerSpreads.map(spread => new ArraySchema(...spread.map(card => new Card(card.rank, card.suit))))));
        });

        // Update individual player properties (e.g., hitPenaltyRounds)
        this.state.players.forEach((player, index) => {
            const updatedPlayer = updatedState.players[index];
            if (updatedPlayer) {
                player.assign({
                    chips: updatedPlayer.chips,
                    status: updatedPlayer.status,
                    hitPenaltyRounds: updatedPlayer.hitPenaltyRounds,
                    hitCount: updatedPlayer.hitCount
                });
            }
        });

        // Update chip balances map
        this.state.chipBalances.clear();
        for (const username in updatedState.chipBalances) {
            this.state.chipBalances.set(username, updatedState.chipBalances[username]);
        }

        // Persist state to MongoDB
        this.tableDb.gameState = this.state.toJSON();
        this.tableDb.players = this.state.players.toJSON(); // Ensure DB players are in sync
        this.tableDb.readyPlayers = this.state.readyPlayers.toJSON(); // Ensure DB readyPlayers are in sync
        await this.tableDb.save();

        if (this.state.gameOver) {
            await this.handleGameEnd();
        } else if (!this.state.players[this.state.currentTurn].isHuman) {
            // If next turn is AI, schedule AI turn
            this.clock.setTimeout(this.handleAiTurn.bind(this), 800);
        }
    }

    async handleAiTurn() {
        console.log(`🤖 AI Turn: Player ${this.state.players[this.state.currentTurn].username}`);

        if (this.state.gameOver) {
            console.log("AI turn skipped: Game is over.");
            return;
        }

        // Convert Colyseus Schema objects to plain JS objects for runAiTurn
        const plainState = this.state.toJSON();
        plainState.playerHands = plainState.playerHands.map(hand => hand.map(card => ({ ...card })));
        plainState.playerSpreads = plainState.playerSpreads.map(playerSpreads => playerSpreads.map(spread => spread.map(card => ({ ...card }))));
        plainState.deck = plainState.deck.map(card => ({ ...card }));
        plainState.discardPile = plainState.discardPile.map(card => ({ ...card }));
        plainState.players = plainState.players.map(p => ({ ...p }));

        const updatedState = runAiTurn(plainState);

        // Update Colyseus state from the processed state
        this.state.assign({
            deck: new ArraySchema(...updatedState.deck.map(card => new Card(card.rank, card.suit))),
            discardPile: new ArraySchema(...updatedState.discardPile.map(card => new Card(card.rank, card.suit))),
            currentTurn: updatedState.currentTurn,
            hasDrawnCard: updatedState.hasDrawnCard,
            gameOver: updatedState.gameOver,
            gameStarted: updatedState.gameStarted,
            winners: new ArraySchema(...updatedState.winners),
            winType: updatedState.winType,
            roundScores: new ArraySchema(...updatedState.roundScores),
            caught: updatedState.caught,
            gameEndMessage: updatedState.gameEndMessage,
            gameEndReason: updatedState.gameEndReason,
            pot: updatedState.pot,
            timestamp: Date.now()
        });

        // Update playerHands and playerSpreads carefully as they are nested ArraySchemas
        this.state.playerHands.splice(0, this.state.playerHands.length); // Clear existing
        updatedState.playerHands.forEach(hand => {
            this.state.playerHands.push(new ArraySchema(...hand.map(card => new Card(card.rank, card.suit))));
        });

        this.state.playerSpreads.splice(0, this.state.playerSpreads.length); // Clear existing
        updatedState.playerSpreads.forEach(playerSpreads => {
            this.state.playerSpreads.push(new ArraySchema(...playerSpreads.map(spread => new ArraySchema(...spread.map(card => new Card(card.rank, card.suit))))));
        });

        // Update individual player properties (e.g., hitPenaltyRounds)
        this.state.players.forEach((player, index) => {
            const updatedPlayer = updatedState.players[index];
            if (updatedPlayer) {
                player.assign({
                    chips: updatedPlayer.chips,
                    status: updatedPlayer.status,
                    hitPenaltyRounds: updatedPlayer.hitPenaltyRounds,
                    hitCount: updatedPlayer.hitCount
                });
            }
        });

        // Update chip balances map
        this.state.chipBalances.clear();
        for (const username in updatedState.chipBalances) {
            this.state.chipBalances.set(username, updatedState.chipBalances[username]);
        }

        // Persist state to MongoDB
        this.tableDb.gameState = this.state.toJSON();
        this.tableDb.players = this.state.players.toJSON();
        this.tableDb.readyPlayers = this.state.readyPlayers.toJSON();
        await this.tableDb.save();

        if (this.state.gameOver) {
            await this.handleGameEnd();
        } else if (!this.state.players[this.state.currentTurn].isHuman) {
            this.clock.setTimeout(this.handleAiTurn.bind(this), 800);
        }
    }

    async handlePlayerReady(client, message) {
        const username = message.username;
        console.log(`Player ${username} is ready.`);

        if (!this.state.readyPlayers.includes(username)) {
            this.state.readyPlayers.push(username);
        }

        // Auto-ready AI players if present
        this.state.players.forEach(player => {
            if (!player.isHuman && !this.state.readyPlayers.includes(player.username)) {
                this.state.readyPlayers.push(player.username);
            }
        });

        // Update DB
        this.tableDb.readyPlayers = this.state.readyPlayers.toJSON();
        await this.tableDb.save();

        this.broadcast("player_ready_update", {
            readyPlayers: this.state.readyPlayers.toJSON(),
            username: username,
            totalPlayers: this.state.players.filter(p => p.isHuman).length,
            readyCount: this.state.readyPlayers.length
        });

        this.checkAndStartGame();
    }

    async checkAndStartGame() {
        const activePlayers = this.state.players.filter(p => p.status === 'active');
        const humanPlayers = activePlayers.filter(p => p.isHuman);
        const aiPlayers = activePlayers.filter(p => !p.isHuman);

        // Remove AI if 2 or more human players are present and AI exists
        if (humanPlayers.length >= 2 && aiPlayers.length > 0) {
            console.log(`🧹 Removing AI player(s) from table ${this.tableDb._id} as human players count is ${humanPlayers.length}`);
            const removedAiUsernames = [];
            this.state.players = this.state.players.filter(p => {
                if (!p.isHuman) {
                    removedAiUsernames.push(p.username);
                    // Also remove from chipBalances map
                    if (this.state.chipBalances.has(p.username)) {
                        this.state.chipBalances.delete(p.username);
                    }
                    return false; // Remove AI player
                }
                return true; // Keep human players
            });

            // Update DB table players
            this.tableDb.players = this.tableDb.players.filter(p => {
                if (!p.isHuman) {
                    return false; // Remove AI player from DB
                }
                return true;
            });
            await this.tableDb.save();

            // Broadcast that AI players have left
            removedAiUsernames.forEach(username => {
                this.broadcast("player_left", {
                    sessionId: `ai-${username}`, // Use a consistent identifier for AI
                    username: username,
                    players: this.state.players.toJSON()
                });
            });

            // Re-evaluate players after AI removal
            const reEvaluatedActivePlayers = this.state.players.filter(p => p.status === 'active');
            const reEvaluatedHumanPlayers = reEvaluatedActivePlayers.filter(p => p.isHuman);
            const reEvaluatedAiPlayers = reEvaluatedActivePlayers.filter(p => !p.isHuman);

            // If after removing AI, there's only one human, add AI back (this handles cases where AI was removed but then a human left)
            if (reEvaluatedHumanPlayers.length === 1 && reEvaluatedAiPlayers.length === 0 && reEvaluatedActivePlayers.length < this.maxClients) {
                console.log(`🤖 Re-adding AI companion for lone human at table ${this.tableDb._id} after AI removal`);
                const aiPlayerName = `AI Player ${this.tableDb._id.toString().slice(-4)}`;
                const newAiPlayer = new Player(aiPlayerName, 1000, false, `ai-${Date.now()}`);
                this.state.players.push(newAiPlayer);
                this.state.chipBalances.set(aiPlayerName, 1000);

                // Update DB
                this.tableDb.players.push({
                    username: newAiPlayer.username,
                    chips: newAiPlayer.chips,
                    isHuman: newAiPlayer.isHuman,
                    socketId: newAiPlayer.sessionId,
                    joinedAt: new Date(),
                    status: 'active'
                });
                await this.tableDb.save();

                this.broadcast("player_joined", {
                    username: newAiPlayer.username,
                    players: this.state.players.toJSON()
                });
            }
            // Re-check after AI removal/re-addition
            this.checkAndStartGame();
            return;
        }

        // Add AI if only 1 human and no AI present (original logic, now after AI removal check)
        if (humanPlayers.length === 1 && aiPlayers.length === 0 && activePlayers.length < this.maxClients) {
            console.log(`🤖 Adding AI companion for lone human at table ${this.tableDb._id}`);
            const aiPlayerName = `AI Player ${this.tableDb._id.toString().slice(-4)}`;
            const newAiPlayer = new Player(aiPlayerName, 1000, false, `ai-${Date.now()}`);
            this.state.players.push(newAiPlayer);
            this.state.chipBalances.set(aiPlayerName, 1000);

            // Update DB
            this.tableDb.players.push({
                username: newAiPlayer.username,
                chips: newAiPlayer.chips,
                isHuman: newAiPlayer.isHuman,
                socketId: newAiPlayer.sessionId,
                joinedAt: new Date(),
                status: 'active'
            });
            await this.tableDb.save();

            this.broadcast("player_joined", {
                username: newAiPlayer.username,
                players: this.state.players.toJSON()
            });
            // Re-check after adding AI
            this.checkAndStartGame();
            return;
        }

        const finalActivePlayers = this.state.players.filter(p => p.status === 'active');
        const finalHumanPlayers = finalActivePlayers.filter(p => p.isHuman);
        // const finalAiPlayers = finalActivePlayers.filter(p => !p.isHuman); // No longer needed here as AI should be handled above

        const allHumansReady = finalHumanPlayers.every(p => this.state.readyPlayers.includes(p.username));

        if (finalActivePlayers.length >= 2 && allHumansReady && !this.state.gameStarted && !this.state.gameOver) {
            console.log(`🚀 Starting game countdown for table ${this.tableDb._id}`);
            this.startCountdown();
        }
    }

    startCountdown() {
        if (this.countdownInterval) return; // Already counting down

        let countdown = 3;
        this.state.gameStartingCountdown = countdown;
        this.state.message = `Game starting in ${countdown}...`;

        this.countdownInterval = this.clock.setInterval(() => {
            countdown--;
            this.state.gameStartingCountdown = countdown;
            this.state.message = `Game starting in ${countdown}...`;

            if (countdown <= 0) {
                this.clock.clearInterval(this.countdownInterval);
                this.countdownInterval = null;
                this.startNewHand();
            }
        }, 1000);
    }

    async startNewHand() {
        console.log(`🎮 Starting new hand at table ${this.tableDb._id}`);

        // Deduct stake from each player's chips at the start of a new hand
        for (const player of this.state.players) {
            if (player.isHuman) { // Only deduct from human players
                const user = await User.findOne({ username: player.username });
                if (user) {
                    user.chips -= this.state.stake;
                    user.chips = Math.max(0, user.chips); // Ensure chips don't go below zero
                    await user.save();
                    player.chips = user.chips; // Update Colyseus state player chips
                    this.state.chipBalances.set(player.username, user.chips); // Update chip balance map
                    console.log(`💸 Deducted ${this.state.stake} chips from ${player.username}. New balance: ${player.chips}`);
                }
            }
        }

        // Initialize fresh game state using the core game logic function
        const tempTableState = {
            players: this.state.players.toJSON(), // Pass plain objects
            stake: this.state.stake,
            gameState: null // Ensure it's fresh
        };
        coreInitializeGameState(tempTableState); // This modifies tempTableState.gameState

        // Assign the new game state to Colyseus state
        this.state.assign({
            deck: new ArraySchema(...tempTableState.gameState.deck.map(card => new Card(card.rank, card.suit))),
            discardPile: new ArraySchema(...tempTableState.gameState.discardPile.map(card => new Card(card.rank, card.suit))),
            currentTurn: tempTableState.gameState.currentTurn,
            hasDrawnCard: tempTableState.gameState.hasDrawnCard,
            gameStarted: tempTableState.gameState.gameStarted,
            gameOver: tempTableState.gameState.gameOver,
            winners: new ArraySchema(...tempTableState.gameState.winners),
            winType: tempTableState.gameState.winType,
            roundScores: new ArraySchema(...tempTableState.gameState.roundScores),
            stake: tempTableState.gameState.stake,
            pot: tempTableState.gameState.pot,
            isInitialized: tempTableState.gameState.isInitialized,
            isLoading: tempTableState.gameState.isLoading,
            timestamp: Date.now(),
            message: 'New hand started!'
        });

        // Update playerHands and playerSpreads
        this.state.playerHands.splice(0, this.state.playerHands.length);
        tempTableState.gameState.playerHands.forEach(hand => {
            this.state.playerHands.push(new ArraySchema(...hand.map(card => new Card(card.rank, card.suit))));
        });

        this.state.playerSpreads.splice(0, this.state.playerSpreads.length);
        tempTableState.gameState.playerSpreads.forEach(playerSpreads => {
            this.state.playerSpreads.push(new ArraySchema(...playerSpreads.map(spread => new ArraySchema(...spread.map(card => new Card(card.rank, card.suit))))));
        });

        // Update individual player properties (e.g., hitPenaltyRounds)
        this.state.players.forEach((player, index) => {
            const updatedPlayer = tempTableState.gameState.players[index];
            if (updatedPlayer) {
                player.assign({
                    chips: updatedPlayer.chips,
                    status: updatedPlayer.status,
                    hitPenaltyRounds: updatedPlayer.hitPenaltyRounds,
                    hitCount: updatedPlayer.hitCount
                });
            }
        });

        this.state.readyPlayers.clear(); // Clear ready players for new hand

        // Persist state to MongoDB
        this.tableDb.gameState = this.state.toJSON();
        this.tableDb.players = this.state.players.toJSON();
        this.tableDb.readyPlayers = this.state.readyPlayers.toJSON();
        await this.tableDb.save();

        // If first turn is AI, schedule AI turn
        if (!this.state.gameOver && !this.state.players[this.state.currentTurn].isHuman) {
            this.clock.setTimeout(this.handleAiTurn.bind(this), 800);
        }
    }

    async handleGameEnd() {
        console.log(`🏁 Game ended at table ${this.tableDb._id}. Win Type: ${this.state.winType}`);

        const { winners, winType, roundScores, stake, players } = this.state.toJSON();
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
            this.state.chipBalances.set(player.username, user.chips); // Update Colyseus state chip balance
            console.log(`📊 Updated stats for ${player.username}: gamesPlayed=${user.stats.gamesPlayed}, wins=${user.stats.wins}, reemWins=${user.stats.reemWins}, totalEarnings=${user.stats.totalEarnings}, chips=${user.chips}`);
        }

        // Persist final state to MongoDB
        this.tableDb.gameState = this.state.toJSON();
        this.tableDb.players = this.state.players.toJSON();
        this.tableDb.readyPlayers = this.state.readyPlayers.toJSON();
        await this.tableDb.save();

        // Reset game state for next hand (but keep players)
        this.state.gameStarted = false;
        this.state.gameOver = true; // Keep gameOver true until players ready up for next hand
        this.state.hasDrawnCard = false;
        this.state.currentTurn = 0;
        this.state.deck.clear();
        this.state.discardPile.clear();
        this.state.playerHands.clear();
        this.state.playerSpreads.clear();
        this.state.winners.clear();
        this.state.winType = "";
        this.state.roundScores.clear();
        this.state.caught = null;
        this.state.gameEndMessage = "Game Over!";
        this.state.gameEndReason = `Game ended by ${winType}`;
        this.state.timestamp = Date.now();
        this.state.message = "Game Over! Ready up for the next hand.";
    }

    endGameDueToInsufficientPlayers() {
        console.log(`Game ended due to insufficient players at table ${this.tableDb._id}`);
        this.state.gameOver = true;
        this.state.gameStarted = false;
        this.state.winners.clear();
        this.state.winType = "INSUFFICIENT_PLAYERS";
        this.state.gameEndMessage = "Game ended: Not enough players.";
        this.state.gameEndReason = "Insufficient players";
        this.state.timestamp = Date.now();
        this.state.message = "Game ended due to insufficient players. Waiting for more players.";

        // Clear hands, deck, discard pile
        this.state.deck.clear();
        this.state.discardPile.clear();
        this.state.playerHands.clear();
        this.state.playerSpreads.clear();
        this.state.readyPlayers.clear();

        // Persist state to MongoDB
        this.tableDb.gameState = this.state.toJSON();
        this.tableDb.players = this.state.players.toJSON();
        this.tableDb.readyPlayers = this.state.readyPlayers.toJSON();
        this.tableDb.status = 'waiting'; // Set table status back to waiting
        this.tableDb.save();
    }
}

module.exports = { GameRoom, GameState, Player, Card };