/**
 * Smart Queue Management System
 * Provides intelligent player queuing with priority handling and wait time estimation
 */

class SmartQueueManager {
  constructor() {
    this.queues = new Map();
    this.queueLocks = new Map();
    this.playerPreferences = new Map(); // Track player preferences
    this.waitTimeHistory = new Map(); // Track historical wait times
    this.priorityQueues = new Map(); // VIP/priority players
  }

  /**
   * Initialize queues for stake levels
   */
  initializeQueues(stakes) {
    stakes.forEach(stake => {
      if (!this.queues.has(stake)) {
        this.queues.set(stake, []);
        this.queueLocks.set(stake, false);
        this.waitTimeHistory.set(stake, []);
      }
    });
  }

  /**
   * Add player to queue with intelligent positioning
   */
  addToQueue(stake, player, priority = 'normal') {
    if (!this.queues.has(stake)) {
      throw new Error('Invalid stake level');
    }

    const queue = this.queues.get(stake);
    
    // Avoid duplicates
    if (queue.some(p => p.username === player.username)) {
      return this.getQueuePosition(stake, player.username);
    }

    const queueEntry = {
      ...player,
      joinedAt: new Date(),
      priority: priority,
      estimatedWait: this.calculateEstimatedWait(stake, queue.length),
      preferences: this.playerPreferences.get(player.username) || {}
    };

    // Insert based on priority
    if (priority === 'high' || priority === 'vip') {
      // Find insertion point after other high priority players
      const insertIndex = queue.findIndex(p => p.priority === 'normal');
      if (insertIndex === -1) {
        queue.push(queueEntry);
      } else {
        queue.splice(insertIndex, 0, queueEntry);
      }
    } else {
      queue.push(queueEntry);
    }

    console.log(`Player ${player.username} added to $${stake} queue (priority: ${priority})`);
    return this.getQueuePosition(stake, player.username);
  }

  /**
   * Remove player from queue
   */
  removeFromQueue(stake, username) {
    if (this.queues.has(stake)) {
      const queue = this.queues.get(stake);
      const playerIndex = queue.findIndex(p => p.username === username);
      
      if (playerIndex !== -1) {
        const player = queue[playerIndex];
        const waitTime = Date.now() - player.joinedAt.getTime();
        
        // Record wait time for analytics
        this.recordWaitTime(stake, waitTime);
        
        queue.splice(playerIndex, 1);
        console.log(`Player ${username} removed from $${stake} queue`);
        
        // Update estimated wait times for remaining players
        this.updateEstimatedWaitTimes(stake);
      }
    }
  }

  /**
   * Get player's position in queue
   */
  getQueuePosition(stake, username) {
    const queue = this.queues.get(stake) || [];
    const position = queue.findIndex(p => p.username === username);
    
    if (position === -1) return null;
    
    return {
      position: position + 1,
      queueSize: queue.length,
      estimatedWait: queue[position].estimatedWait,
      priority: queue[position].priority,
      averageWaitTime: this.getAverageWaitTime(stake)
    };
  }

  /**
   * Calculate estimated wait time
   */
  calculateEstimatedWait(stake, queuePosition) {
    const avgWaitTime = this.getAverageWaitTime(stake);
    const baseWaitTime = avgWaitTime || 30; // Default 30 seconds if no history
    
    // Factor in current queue position and table availability
    const positionMultiplier = Math.max(1, queuePosition / 2);
    const estimatedWait = baseWaitTime * positionMultiplier;
    
    return Math.round(estimatedWait);
  }

  /**
   * Get average wait time for stake level
   */
  getAverageWaitTime(stake) {
    const history = this.waitTimeHistory.get(stake) || [];
    if (history.length === 0) return null;
    
    const recentHistory = history.slice(-10); // Last 10 assignments
    const avgMs = recentHistory.reduce((sum, time) => sum + time, 0) / recentHistory.length;
    
    return Math.round(avgMs / 1000); // Convert to seconds
  }

  /**
   * Record wait time for analytics
   */
  recordWaitTime(stake, waitTimeMs) {
    const history = this.waitTimeHistory.get(stake) || [];
    history.push(waitTimeMs);
    
    // Keep only recent history (last 50 entries)
    if (history.length > 50) {
      history.shift();
    }
    
    this.waitTimeHistory.set(stake, history);
  }

  /**
   * Update estimated wait times for all players in queue
   */
  updateEstimatedWaitTimes(stake) {
    const queue = this.queues.get(stake);
    if (!queue) return;
    
    queue.forEach((player, index) => {
      player.estimatedWait = this.calculateEstimatedWait(stake, index);
    });
  }

  /**
   * Get next player from queue with smart selection
   */
  getNextPlayer(stake, tableRequirements = {}) {
    const queue = this.queues.get(stake);
    if (!queue || queue.length === 0) return null;

    // Find best match based on requirements and preferences
    let selectedIndex = 0;
    
    // Prefer players who have been waiting longer (FIFO with priority)
    const highPriorityIndex = queue.findIndex(p => p.priority === 'high' || p.priority === 'vip');
    if (highPriorityIndex !== -1) {
      selectedIndex = highPriorityIndex;
    }

    const player = queue.splice(selectedIndex, 1)[0];
    
    // Record successful assignment
    const waitTime = Date.now() - player.joinedAt.getTime();
    this.recordWaitTime(stake, waitTime);
    
    // Update remaining players' wait times
    this.updateEstimatedWaitTimes(stake);
    
    return player;
  }

  /**
   * Set player preferences
   */
  setPlayerPreferences(username, preferences) {
    this.playerPreferences.set(username, {
      ...this.playerPreferences.get(username),
      ...preferences,
      updatedAt: new Date()
    });
  }

  /**
   * Get queue statistics
   */
  getQueueStats(stake) {
    const queue = this.queues.get(stake) || [];
    const history = this.waitTimeHistory.get(stake) || [];
    
    return {
      currentSize: queue.length,
      averageWaitTime: this.getAverageWaitTime(stake),
      longestWaitingPlayer: queue.length > 0 ? 
        Math.round((Date.now() - queue[0].joinedAt.getTime()) / 1000) : 0,
      totalAssignments: history.length,
      priorityPlayers: queue.filter(p => p.priority !== 'normal').length
    };
  }

  /**
   * Get all queues state
   */
  getQueues() {
    return this.queues;
  }

  /**
   * Lock/unlock queue for processing
   */
  setQueueLock(stake, locked) {
    this.queueLocks.set(stake, locked);
  }

  isQueueLocked(stake) {
    return this.queueLocks.get(stake) || false;
  }

  /**
   * Clear expired queue entries (players who disconnected)
   */
  clearExpiredEntries(maxAgeMinutes = 10) {
    const cutoffTime = new Date();
    cutoffTime.setMinutes(cutoffTime.getMinutes() - maxAgeMinutes);

    this.queues.forEach((queue, stake) => {
      const originalLength = queue.length;
      const filteredQueue = queue.filter(player => player.joinedAt > cutoffTime);
      
      if (filteredQueue.length !== originalLength) {
        this.queues.set(stake, filteredQueue);
        console.log(`Cleared ${originalLength - filteredQueue.length} expired entries from $${stake} queue`);
      }
    });
  }

  /**
   * Get comprehensive queue status for all stakes
   */
  getAllQueueStatus() {
    const status = {};
    
    this.queues.forEach((queue, stake) => {
      status[stake] = {
        ...this.getQueueStats(stake),
        players: queue.map(p => ({
          username: p.username,
          position: queue.indexOf(p) + 1,
          waitTime: Math.round((Date.now() - p.joinedAt.getTime()) / 1000),
          estimatedWait: p.estimatedWait,
          priority: p.priority
        }))
      };
    });
    
    return status;
  }
}

// Create singleton instance
const smartQueueManager = new SmartQueueManager();

module.exports = {
  smartQueueManager,
  initializeQueues: (stakes) => smartQueueManager.initializeQueues(stakes),
  addToQueue: (stake, player, priority) => smartQueueManager.addToQueue(stake, player, priority),
  removeFromQueue: (stake, username) => smartQueueManager.removeFromQueue(stake, username),
  getQueues: () => smartQueueManager.getQueues(),
  setQueueLock: (stake, locked) => smartQueueManager.setQueueLock(stake, locked),
  isQueueLocked: (stake) => smartQueueManager.isQueueLocked(stake),
  getQueuePosition: (stake, username) => smartQueueManager.getQueuePosition(stake, username),
  getNextPlayer: (stake, requirements) => smartQueueManager.getNextPlayer(stake, requirements),
  setPlayerPreferences: (username, prefs) => smartQueueManager.setPlayerPreferences(username, prefs),
  getQueueStats: (stake) => smartQueueManager.getQueueStats(stake),
  getAllQueueStatus: () => smartQueueManager.getAllQueueStatus(),
  clearExpiredEntries: (maxAge) => smartQueueManager.clearExpiredEntries(maxAge)
};