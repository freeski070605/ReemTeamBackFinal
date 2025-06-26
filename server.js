const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const WebSocket = require('ws');
require('dotenv').config();

const User = require('./models/User');
const Game = require('./models/Game');
const {Table, PRESET_TABLES} = require('./models/Table');
const userRoutes = require('./routes/userRoutes');
const gameRoutes = require('./routes/gameRoutes');
const tableRoutes = require('./routes/tableRoutes'); // Ensure this is imported
const { handleWebSocketConnection } = require('./models/useWebSocket');

const app = express();


// Configure CORS options
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'http://localhost:3000',
      'https://reem-team-front-final.vercel.app'
    ];

const corsOptions = {
  origin: allowedOrigins,
  credentials: true // Allow credentials (cookies, HTTP authentication)
};

// Middleware
app.use(cors(corsOptions));
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Secure cookie in production
    httpOnly: true, // Prevent client-side JS access
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax', // Stricter in production
    maxAge: 24 * 60 * 60 * 1000 // 24 hours (optional)
  },
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI, // Use the same MongoDB URI as your app
    collectionName: 'sessions', // Optional: specify a collection name
    ttl: 24 * 60 * 60, // Session TTL in seconds (optional, defaults to session cookie maxAge)
    autoRemove: 'interval', // Automatic removal of expired sessions
    autoRemoveInterval: 10 // Interval in minutes for removing expired sessions
  })
}));

// Ensure environment variables are set
if (!process.env.MONGODB_URI || !process.env.SESSION_SECRET || !process.env.FRONTEND_ORIGIN) {
  throw new Error('Missing required environment variables');
}

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('MongoDB connected');
}).catch((err) => {
  console.error('MongoDB connection error:', err);
});

// Routes
app.use((req, res, next) => {
    req.io = io;
    next();
});

app.use('/users', userRoutes);
app.use('/games', gameRoutes);
app.use('/tables', tableRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal Server Error' });
});

// Initialize preset tables
const initializePresetTables = async () => {
  try {
      await Table.deleteMany({}); // Clear existing tables
      const tables = await Table.insertMany(PRESET_TABLES.map((table, index) => ({ // Added 'index' here
          ...table, // Spread existing table properties (name, stake)
          tableId: `table-${index + 1}`, // Generate unique tableId using index
          players: [],
          isActive: true
      })));
      console.log('Preset tables initialized');
      return tables;
  } catch (error) {
      console.error('Error initializing preset tables:', error);
  }
};



// Start the HTTP server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  initializePresetTables();
  console.log(`Server is running on port ${PORT}`);
});

// Start the WebSocket server
const io = require('socket.io')(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["my-custom-header"]
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000
});

// Import cleanup functions
const { cleanupDisconnectedPlayers, cleanupEmptyTables } = require('./utils/leaveTableHandler');
const { assignPlayersToTables } = require('./models/useWebSocket');

// Set up periodic cleanup tasks
const runPeriodicCleanup = async () => {
  try {
    await cleanupDisconnectedPlayers(io, 5, assignPlayersToTables); // 5 minute timeout
    await cleanupEmptyTables(io);
    await assignPlayersToTables(io);
  } catch (error) {
    console.error('Error in periodic cleanup:', error);
  }
};

// Run cleanup every 30 seconds
setInterval(runPeriodicCleanup, process.env.SOCKET_CLEANUP_INTERVAL || 30000);

// Run table assignment every 10 seconds
setInterval(() => assignPlayersToTables(io), process.env.SOCKET_ASSIGNMENT_INTERVAL || 10000);

// Make io available to routes
app.set('io', io);

io.on('connection', (socket) => handleWebSocketConnection(socket, io));
