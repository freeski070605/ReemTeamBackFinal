const jwt = require('jsonwebtoken');
const User = require('../models/User');

const authenticateToken = (req, res, next) => {
  const token = req.header('Authorization') && req.header('Authorization').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied, no token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (ex) {
    res.status(400).json({ error: 'Invalid token' });
  }
};

const isAdmin = async (req, res, next) => {
  if (!req.user || !req.user.username) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const user = await User.findOne({ username: req.user.username });
    if (user && user.isAdmin) {
      next();
    } else {
      res.status(403).json({ error: 'Forbidden' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = { authenticateToken, isAdmin };
