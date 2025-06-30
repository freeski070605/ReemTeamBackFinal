const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const MongoStore = require('connect-mongo');
const { Server } = require('colyseus');
const { createServer } = require('http');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const User = require('./models/User');
const Game = require('./models/Game');
const { Table, PRESET_TABLES } = require('./models/Table');
const userRoutes = require('./routes/userRoutes');
const gameRoutes = require('./routes/gameRoutes');
const tableRoutes = require('./routes/tableRoutes'); // Ensure this is imported
const { GameRoom } = require('./rooms/GameRoom');

const app = express();


// Configure CORS options
const frontendOrigin = process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.replace(/\/$/, '') : 'https://reem-team-front-final.vercel.app';
const allowedOrigins = [
  'http://localhost:3000',
  frontendOrigin
];


const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      console.error('CORS Error: Origin not allowed -', origin);
      return callback(new Error(msg), false);
    }
    console.log('CORS: Origin allowed -', origin);
    return callback(null, true);
  },
  credentials: true, // Allow credentials (cookies, HTTP authentication)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Explicitly allow common methods
  allowedHeaders: ['Content-Type', 'Authorization'] // Explicitly allow common headers
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
}).then(async () => {
  console.log('MongoDB connected');
  // Clear all sessions on server start to ensure all users are logged out
  // This is crucial for production readiness and handling server restarts
  try {
    await mongoose.connection.db.collection('sessions').deleteMany({});
    console.log('All existing sessions cleared from MongoDB.');
  } catch (error) {
    console.error('Error clearing sessions on startup:', error);
  }
}).catch((err) => {
  console.error('MongoDB connection error:', err);
});

// Routes

app.use('/users', userRoutes);
app.use('/games', gameRoutes);
app.use('/tables', tableRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Internal Server Error' });
});

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

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('Shutting down server gracefully...');
  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed.');
    // Perform any additional cleanup here, e.g., saving game states
    console.log('Additional cleanup complete. Exiting process.');
    process.exit(0);
  });

  // Force close after a timeout
  setTimeout(() => {
    console.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 10000); // 10 seconds timeout
};

// Listen for termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Catch unhandled exceptions and rejections
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err.message, err.stack);
  // Attempt graceful shutdown, but exit quickly if it fails
  gracefulShutdown();
  setTimeout(() => {
    console.error('Forcing exit due to uncaught exception after graceful shutdown attempt.');
    process.exit(1);
  }, 5000); // 5 seconds to exit
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
  // For production, consider logging to an external service
});

// Create HTTP server
const gameServer = createServer(app);

// Create Colyseus server
const colyseus = new Server({
  transport: new WebSocketTransport({
    server: gameServer, // Attach Colyseus to the existing HTTP server
    pingInterval: 5000, // Ping clients every 5 seconds
    pingMaxRetries: 3, // Disconnect after 3 missed pings
  })
});

// Define Colyseus Rooms dynamically based on stake
// The ':stake' parameter allows clients to join rooms like 'tonk_1', 'tonk_5', etc.
colyseus.define('tonk_:stake', GameRoom, { stake: "$params.stake" });

// Start the Colyseus server
colyseus.listen(PORT);

console.log(`Colyseus server listening on ws://localhost:${PORT}`);
