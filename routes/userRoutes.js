const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const router = express.Router();

// Register route with enhanced validation and response
router.post('/register', async (req, res) => {
    const { username, email, password } = req.body;

    // Enhanced input validation
    if (!username?.trim() || !email?.trim() || !password?.trim()) {
        return res.status(400).json({ 
            success: false, 
            message: 'All fields are required',
            validationErrors: {
                username: !username?.trim() ? 'Username is required' : null,
                email: !email?.trim() ? 'Email is required' : null,
                password: !password?.trim() ? 'Password is required' : null
            }
        });
    }

    try {
        // Check for existing user with enhanced response
        const existingUser = await User.findOne({ 
            $or: [
                { username: username.trim().toLowerCase() },
                { email: email.trim().toLowerCase() }
            ]
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: existingUser.username === username.trim() ? 
                    'Username already taken' : 'Email already registered'
            });
        }

        // Create new user with initial chips
        const user = new User({
            username: username.trim(),
            email: email.trim().toLowerCase(),
            password,
            chips: 1000, // Starting chips for new users
            isAdmin: false,
            lastLogin: new Date(),
            gamesPlayed: 0,
            totalWinnings: 0
        });

        await user.save();
        res.status(201).json({
            success: true,
            message: 'Registration successful',
            initialChips: user.chips
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Registration failed',
            error: error.message
        });
    }
});

// Enhanced login route with session management
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        // Update user statistics
        user.lastLogin = new Date();
        await user.save();

        // Enhanced user data response
        const userData = {
            username: user.username,
            email: user.email,
            chips: user.chips,
            isAdmin: user.isAdmin,
            gamesPlayed: user.gamesPlayed,
            totalWinnings: user.totalWinnings,
            lastLogin: user.lastLogin
        };

        req.session.userId = user._id;
        res.status(200).json({
            success: true,
            user: userData,
            message: 'Login successful'
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Login failed',
            error: error.message
        });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.status(200).json({ success: true, message: 'Logout successful' });
    });
});

// Enhanced profile route with detailed user statistics
router.get('/profile', async (req, res) => {
    try {
        if (!req.session.userId) {
            return res.status(401).json({
                success: false,
                message: 'Session expired'
            });
        }

        const user = await User.findById(req.session.userId)
            .select('-password')
            .lean();

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.status(200).json({
            success: true,
            user: {
                ...user,
                winRate: user.gamesPlayed ? 
                    (user.totalWinnings / user.gamesPlayed).toFixed(2) : 0
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch profile',
            error: error.message
        });
    }
});

// Enhanced chip update route with transaction logging
router.put('/:username/updateChips', async (req, res) => {
    const { username } = req.params;
    const { chips, gameId, reason } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        const previousBalance = user.chips;
        user.chips = chips;
        user.totalWinnings += chips - previousBalance;

        // Log transaction
        user.transactions = user.transactions || [];
        user.transactions.push({
            amount: chips - previousBalance,
            type: chips > previousBalance ? 'WIN' : 'LOSS',
            gameId,
            reason,
            timestamp: new Date()
        });

        await user.save();

        res.status(200).json({
            success: true,
            message: 'Chips updated successfully',
            newBalance: user.chips,
            transaction: user.transactions[user.transactions.length - 1]
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to update chips',
            error: error.message
        });
    }
});

// Enhanced user data route with statistics
router.get('/:username', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username })
            .select('-password -transactions')
            .lean();

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.status(200).json({
            success: true,
            user: {
                ...user,
                winRate: user.gamesPlayed ? 
                    (user.totalWinnings / user.gamesPlayed).toFixed(2) : 0
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch user data',
            error: error.message
        });
    }
});

// Add a specific balance route for ChipSystem
router.get('/:username/balance', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username })
            .select('chips');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.status(200).json({
            success: true,
            chips: user.chips
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to fetch balance',
            error: error.message
        });
    }
});

// Add these new routes to the existing file

// Update stats route
router.get('/:username/stats', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if (!user) {
            return res.status(200).json({
                success: true,
                stats: {
                    gamesPlayed: 0,
                    wins: 0,
                    reemWins: 0,
                    totalEarnings: 0
                }
            });
        }

        res.status(200).json({
            success: true,
            stats: user.stats || {
                gamesPlayed: 0,
                wins: 0,
                reemWins: 0,
                totalEarnings: 0
            }
        });
    } catch (error) {
        console.error('Stats fetch error:', error);
        res.status(200).json({
            success: true,
            stats: {
                gamesPlayed: 0,
                wins: 0,
                reemWins: 0,
                totalEarnings: 0
            }
        });
    }
});

// Update game history route
router.get('/:username/history', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        res.status(200).json({
            success: true,
            history: user?.gameHistory || []
        });
    } catch (error) {
        console.error('History fetch error:', error);
        res.status(200).json({
            success: true,
            history: []
        });
    }
});


// Update stats route to create default values if missing
router.post('/:username/updateStats', async (req, res) => {
    try {
        const { gameResult, stake, earnings, opponents } = req.body;
        let user = await User.findOne({ username: req.params.username });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Initialize stats if they don't exist
        if (!user.stats) {
            user.stats = {
                gamesPlayed: 0,
                wins: 0,
                reemWins: 0,
                totalEarnings: 0
            };
        }

        // Initialize gameHistory if it doesn't exist
        if (!user.gameHistory) {
            user.gameHistory = [];
        }

        // Update stats
        user.stats.gamesPlayed += 1;
        if (gameResult === 'win') user.stats.wins += 1;
        if (gameResult === 'reem') user.stats.reemWins += 1;
        user.stats.totalEarnings += earnings;

        // Add to game history
        user.gameHistory.push({
            date: new Date(),
            stake,
            result: gameResult,
            earnings,
            opponents
        });

        await user.save();

        res.status(200).json({
            success: true,
            message: 'Stats updated successfully',
            stats: user.stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Failed to update stats',
            error: error.message
        });
    }
});



module.exports = router;
