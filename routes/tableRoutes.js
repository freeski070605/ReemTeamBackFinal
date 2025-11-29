const express = require('express');
const router = express.Router();
const {Table, PRESET_TABLES} = require('../models/Table');
const { authenticateToken, isAdmin } = require('../middleware/authMiddleware');
const { handlePlayerLeave } = require('../utils/leaveTableHandler');



// Create a new table
router.post('/',  async (req, res) => {
  const { name, stake, player } = req.body;

  if (!name || !stake || !player || !player.username || typeof player.chips !== 'number') {
      return res.status(400).json({ error: 'Invalid table or player data' });
  }

  try {
      const newTable = new Table({ name, stake, players: [player] });
      await newTable.save();
      res.status(201).json({ message: 'Table created successfully', table: newTable });
  } catch (error) {
      res.status(500).json({ error: error.message });
  }
});

// Join an existing table
router.post('/join', async (req, res) => {
  const { tableId, player } = req.body;

  if (!player || !player.username || typeof player.chips !== 'number') {
      return res.status(400).json({ error: 'Invalid player data' });
  }

  try {
      const table = await Table.findById(tableId);
      if (!table) {
          return res.status(404).json({ error: 'Table not found' });
      }

      if (table.players.length >= 4) {
          return res.status(400).json({ error: 'Table is full' });
      }

      table.players.push(player);
      await table.save();
      res.status(200).json({ message: 'Joined table successfully', table });
  } catch (error) {
      res.status(500).json({ error: error.message });
  }
});


  // Leave a table


  router.post('/:tableId/leave', async (req, res) => {
    const { tableId } = req.params;
    const { username } = req.body;
  
    try {
      const io = req.app.get('io'); // ✅ Make sure to inject `io` into your Express app
      const { assignPlayersToTables } = require('../models/useWebSocket');
      await handlePlayerLeave({
        tableId,
        username,
        io,
        isDisconnect: false,
        assignPlayersToTables
      });
  
      res.status(200).json({ success: true, message: 'Player removed from table' });
    } catch (error) {
      console.error('Error in REST leave:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

// Delete a table
router.delete('/:id', async (req, res) => {
  try {
    const table = await Table.findByIdAndDelete(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }
    res.status(200).json({ message: 'Table deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get table by ID
router.get('/:id', async (req, res) => {
  try {
    const table = await Table.findById(req.params.id);
    if (!table) {
      return res.status(404).json({ error: 'Table not found' });
    }
    // Add human player if not present
    const playerExists = table.players.some(p => p.username === req.user?.username);
    if (req.user && !playerExists) {
        table.players.push({
            username: req.user.username,
            chips: req.user.chips,
            isHuman: true
        });
        await table.save();
    }

    res.status(200).json({ table });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all tables
router.get('/', async (req, res) => {
  try {
    // Fetch tables and filter out empty ones
    const tables = await Table.find({});
    //console.log('Tables returned to lobby:', tables.map(t => ({ id: t._id, status: t.status, players: t.players.map(p => p.username) })));

    
    res.status(200).json({ success: true, tables });
  } catch (error) {
    console.error('Error fetching tables:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch tables' });
  }
});

// Clean up empty tables
router.post('/cleanup-tables', async (req, res) => {
  try {
    // Find tables with no players
    const emptyTables = await Table.find({ 'players.0': { $exists: false } });
    
    // Delete empty tables
    await Promise.all(emptyTables.map(table => table.remove()));
    
    res.status(200).json({ success: true, message: `${emptyTables.length} empty tables removed` });
  } catch (error) {
    console.error('Error cleaning up tables:', error);
    res.status(500).json({ success: false, error: 'Failed to clean up tables' });
  }
});

router.post('/recover-table/:tableId', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const table = await Table.findById(req.params.tableId).session(session);
    if (!table) {
      throw new Error('Table not found');
    }

    // Remove disconnected players
    table.players = table.players.filter(player => {
      const socket = io.sockets.sockets.get(player.socketId);
      return socket && socket.connected;
    });

    // Reset game state if needed
    if (table.status === 'in_progress' && table.players.length < 2) {
      table.status = 'waiting';
      table.gameState = null;
    }

    await table.save({ session });
    await session.commitTransaction();

    // Notify remaining players
    io.to(table._id).emit('table_recovered', {
      table,
      timestamp: Date.now()
    });

    res.json({ success: true, table });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ success: false, error: error.message });
  } finally {
    session.endSession();
  }
});



// Validate game state
router.post('/:tableId/validate-state', async (req, res) => {
  try {
    const { tableId } = req.params;
    const { stateHash } = req.body;
    
    if (!stateHash) {
      return res.status(400).json({
        valid: false,
        error: 'Missing state hash'
      });
    }
    
    const { validateGameState } = require('../models/gameLogic');
    const validationResult = await validateGameState(tableId, stateHash);
    
    res.json(validationResult);
  } catch (error) {
    console.error('State validation error:', error);
    res.status(500).json({
      valid: false,
      error: 'Server error during validation'
    });
  }
});



module.exports = router;
