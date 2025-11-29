const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  username: {
    type: String,
    required: true
  },
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game'
  },
  tableId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Table'
  },
  type: {
    type: String,
    enum: ['STAKE_DEDUCTION', 'WINNINGS', 'PENALTY', 'REFUND'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  winType: {
    type: String,
    enum: ['regular', 'reem', 'immediate_50', 'special_milestone', 'stock_empty', 'drop_win', 'drop_penalty']
  },
  stake: {
    type: Number
  },
  multiplier: {
    type: Number,
    default: 1
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'rolled_back'],
    default: 'pending'
  },
  transactionId: {
    type: String,
    unique: true,
    required: true
  },
  relatedTransactionId: {
    type: String // For linking refunds to original transactions
  }
}, {
  timestamps: true
});

// Index for performance
transactionSchema.index({ playerId: 1, createdAt: -1 });
transactionSchema.index({ gameId: 1 });
transactionSchema.index({ transactionId: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = Transaction;