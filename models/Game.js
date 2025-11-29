const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
   tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', required: true },
   players: [{
     playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
     username: { type: String, required: true },
     isHuman: { type: Boolean, default: true },
     position: { type: Number, required: true },
     initialBalance: { type: Number, required: true }, // Balance at game start
     finalBalance: { type: Number }, // Balance at game end
   }],
   stake: { type: Number, required: true },
   status: {
     type: String,
     enum: ['waiting', 'in_progress', 'completed', 'abandoned'],
     default: 'waiting'
   },
   gameState: { type: mongoose.Schema.Types.Mixed }, // Complete game state snapshot
   startTime: { type: Date },
   endTime: { type: Date },
   winners: [{
     playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
     username: { type: String },
     winType: {
       type: String,
       enum: ['regular', 'reem', 'immediate_50', 'special_milestone', 'stock_empty', 'drop_win']
     },
     payout: { type: Number }
   }],
   roundScores: [{
     playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
     username: { type: String },
     score: { type: Number },
     hand: [{ rank: String, suit: String }]
   }],
   transactions: [{
     playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
     type: { type: String, enum: ['stake', 'payout', 'penalty'], required: true },
     amount: { type: Number, required: true },
     timestamp: { type: Date, default: Date.now },
     balanceAfter: { type: Number, required: true }
   }],
   aiPlayers: [{
     username: { type: String, required: true },
     difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
     actions: [{
       action: { type: String },
       timestamp: { type: Date },
       stateBefore: { type: mongoose.Schema.Types.Mixed },
       stateAfter: { type: mongoose.Schema.Types.Mixed }
     }]
   }],
   gameConfig: {
     maxPlayers: { type: Number, default: 4 },
     minPlayers: { type: Number, default: 2 },
     timeLimit: { type: Number, default: 300000 }, // 5 minutes in ms
     allowSpectators: { type: Boolean, default: true }
   },
   milestones: [{
     type: { type: String, enum: ['triple_stake', 'double_stake'], required: true },
     playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
     score: { type: Number, required: true },
     handSize: { type: Number, required: true },
     timestamp: { type: Date, default: Date.now }
   }],
   logs: [{
     level: { type: String, enum: ['info', 'warn', 'error'], default: 'info' },
     message: { type: String, required: true },
     playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
     action: { type: String },
     timestamp: { type: Date, default: Date.now },
     metadata: { type: mongoose.Schema.Types.Mixed }
   }]
}, {
   timestamps: true // Adds createdAt and updatedAt
});

const Game = mongoose.model('Game', gameSchema);

module.exports = Game;
