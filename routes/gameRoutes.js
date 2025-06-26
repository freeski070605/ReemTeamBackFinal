const express = require('express');
const Game = require('../models/Game');

const router = express.Router();

// Middleware to check if user is authenticated
const protect = (req, res, next) => {
    if (req.session.userId) {
      next();
    } else {
      res.status(401).json({ message: 'Unauthorized. Please log in.' });
    }
  };

// Create a new game
router.post('/',  async (req, res) => {
  try {
    const game = new Game(req.body);
    await game.save();
    res.status(201).json(game);
  } catch (error) {
    console.error('Failed to create game:', error);
    res.status(400).json({ success: false, message: 'Failed to create game', error });
  }
});

// Update a game by ID
router.put('/games/:id',  async (req, res) => {
  const { id } = req.params;

  try {
    const updatedGame = await Game.findByIdAndUpdate(id, req.body, { new: true });
    if (!updatedGame) {
      return res.status(404).json({ success: false, message: 'Game not found' });
    }
    res.status(200).json(updatedGame);
  } catch (error) {
    console.error('Failed to update game:', error);
    res.status(400).json({ success: false, message: 'Failed to update game', error });
  }
});


module.exports = router;
