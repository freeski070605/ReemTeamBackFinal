const mongoose = require('mongoose');


const tableSchema = new mongoose.Schema({
  tableId: { // Added tableId field
    type: String,
    required: true,
    unique: true // Ensure uniqueness at the schema level
  },
  name: {
    type: String,
    required: true
  },
  players: [{
    username: String,
    chips: Number,
    socketId: String,
    isHuman: Boolean,
    joinedAt: Date,
    lastActive: Date,
    status: {
      type: String,
      enum: ['active', 'disconnected', 'left'],
      default: 'active'
    }
  }],
  stake: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['waiting', 'in_progress', 'completed', 'error'],
    default: 'waiting'
  },
  date: {
    type: Date,
    default: Date.now
  },
  spectators: [
    new mongoose.Schema({
      username: String,
      socketId: String,
      joinedAt: Date,
      chips: Number,
      transitionId: String,
      type: String,
      isHuman: Boolean,
      pendingPlayer: Boolean,
      willJoinNextHand: Boolean
    }, { _id: true })
  ],
  gameState: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  stateVersion: {
    type: Number,
    default: 0
  },
  lastStateUpdate: Date,
  readyPlayers: { // Modified this field
    type: [String], // Explicitly define as array of Strings
    default: []     // ✅ Add default empty array
  },
  lastGameEndedAt: Date // Ensure this field exists if used elsewhere
});

// First, define the preset tables configuration
const PRESET_TABLES = [
  { name: "Table 1", stake: 1 },
  { name: "Table 2", stake: 1 },
  { name: "Table 3", stake: 5 },
  { name: "Table 4", stake: 5 },
  { name: "Table 5", stake: 10 },
  { name: "Table 6", stake: 10 },
  { name: "Table 7", stake: 20 },
  { name: "Table 8", stake: 20 },
  { name: "Table 9", stake: 50 },
  { name: "Table 10", stake: 50 },
  { name: "Table 11", stake: 100 },
  { name: "Table 12", stake: 100 }
];


const Table = mongoose.model('Table', tableSchema);

module.exports = { Table, PRESET_TABLES };

