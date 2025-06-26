const queues = new Map();
const queueLocks = new Map();

// Initialize queues for each stake level
const initializeQueues = (stakes) => {
  stakes.forEach(stake => {
    if (!queues.has(stake)) {
      queues.set(stake, []);
      queueLocks.set(stake, false);
    }
  });
};

// Add a player to a queue
const addToQueue = (stake, player) => {
  if (!queues.has(stake)) {
    throw new Error('Invalid stake level');
  }
  const queue = queues.get(stake);
  // Avoid adding duplicates
  if (!queue.some(p => p.username === player.username)) {
    queue.push(player);
    console.log(`Player ${player.username} added to queue for $${stake}`);
  }
};

// Remove a player from a queue
const removeFromQueue = (stake, username) => {
  if (queues.has(stake)) {
    const queue = queues.get(stake);
    const newQueue = queue.filter(p => p.username !== username);
    queues.set(stake, newQueue);
    console.log(`Player ${username} removed from queue for $${stake}`);
  }
};

// Get the current state of all queues
const getQueues = () => {
    return queues;
};

// Lock or unlock a queue for processing
const setQueueLock = (stake, locked) => {
  queueLocks.set(stake, locked);
};

const isQueueLocked = (stake) => {
  return queueLocks.get(stake);
};

module.exports = {
  initializeQueues,
  addToQueue,
  removeFromQueue,
  getQueues,
  setQueueLock,
  isQueueLocked
};