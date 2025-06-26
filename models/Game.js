const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  players: {
    type: [String], // Array of player usernames
    validate: {
      validator: function(v) {
        return v.length <= 4; // Maximum of 4 players
      },
      message: props => `${props.value.length} exceeds the limit of 4 players!`
    },
    required: true,
  },
  stake: {
    type: Number,
    required: true,
  },
  result: {
    type: String,
    default: 'pending',
  },
  date: {
    type: Date,
    default: Date.now,
  },
});

const Game = mongoose.model('Game', gameSchema);

module.exports = Game;
