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
      cashBalance: Number,
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

// First, define the preset tables configuration - exactly 2 tables per stake level as per spec
const PRESET_TABLES = [
  { name: "$1 Table A", stake: 1 },
  { name: "$1 Table B", stake: 1 },
  { name: "$5 Table A", stake: 5 },
  { name: "$5 Table B", stake: 5 },
  { name: "$10 Table A", stake: 10 },
  { name: "$10 Table B", stake: 10 },
  { name: "$20 Table A", stake: 20 },
  { name: "$20 Table B", stake: 20 },
  { name: "$50 Table A", stake: 50 },
  { name: "$50 Table B", stake: 50 },
  { name: "$100 Table A", stake: 100 },
  { name: "$100 Table B", stake: 100 }
];


const Table = mongoose.model('Table', tableSchema);

module.exports = { Table, PRESET_TABLES };

