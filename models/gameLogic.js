const crypto = require('crypto');

const createDeck = () => {
  const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
  // Exclude 8, 9, 10 from the ranks
  const ranks = ['2', '3', '4', '5', '6', '7', 'J', 'Q', 'K', 'ace'];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit });
    }
  }
  return deck;
};

// Create initial deck constant
const initialDeck = createDeck();

const shuffleDeck = (deck) => {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

const dealHands = (deck, numPlayers) => {
  const hands = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < numPlayers; j++) {
      hands[j].push(deck.pop());
    }
  }
  return hands;
};

const calculatePoints = (hand, spreads = []) => {
  // Updated values excluding 8, 9, 10
  const values = {
    '2': 2, '3': 3, '4': 4, '5': 5,
    '6': 6, '7': 7, J: 10, Q: 10,
    K: 10, ace: 1
  };

  // Get all cards that are in spreads
  const spreadCards = spreads.flat();

  // Only count cards that are still in hand (not in spreads)
  return hand.reduce((total, card) => {
    const isInSpread = spreadCards.some(spreadCard =>
      spreadCard.rank === card.rank && spreadCard.suit === card.suit
    );
    return isInSpread ? total : total + (values[card.rank] || 0);
  }, 0);
};

const isValidSpread = (cards) => {
  if (cards.length < 3) {
    return false;
  }
  
  const allSameRank = cards.every(c => c.rank === cards[0].rank);
  
  if (allSameRank) {
    return true;
  }

  // Updated values excluding 8, 9, 10
  const rankSequenceOrder = ['ace', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];
  const getRankIndex = (rank) => rankSequenceOrder.indexOf(rank);

  const sorted = [...cards].sort((a, b) => getRankIndex(a.rank) - getRankIndex(b.rank));
  
  const sameSuit = sorted.every(c => c.suit === sorted[0].suit);
  
  if (!sameSuit) {
    return false;
  }

  // Check for standard consecutive sequence based on rankSequenceOrder
  let isSequence = true;
  for (let i = 1; i < sorted.length; i++) {
    const currentRankIndex = getRankIndex(sorted[i].rank);
    const previousRankIndex = getRankIndex(sorted[i - 1].rank);
    
    if (currentRankIndex === -1 || previousRankIndex === -1 || currentRankIndex !== previousRankIndex + 1) {
      isSequence = false;
      break;
    }
  }

  if (isSequence) {
    return true;
  }

  return false; // If neither same rank nor valid suited sequence
};


const findBestSpread = (hand) => {
  if (!Array.isArray(hand) || hand.length < 3) return null;

  const combinations = getCombinations(hand, 3);

  for (let combo of combinations) {
    if (isValidSpread(combo)) {
      return combo;
    }
  }
  return null;
};

const getCombinations = (arr, size) => {
  const results = [];
  const helper = (start, combo) => {
    if (combo.length === size) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  };
  helper(0, []);
  return results;
};


// ✅ CORRECTED isValidHit function for backend
const isValidHit = (card, spread) => {
  // A hit must be on an existing spread of at least 3 cards
  if (!Array.isArray(spread) || spread.length < 3) {
      console.log('isValidHit (backend): Spread is not array or too short', spread);
      return false;
  }

  // The card being hit with must be a valid card object
  if (!card || typeof card.rank !== 'string' || typeof card.suit !== 'string') {
      console.log('isValidHit (backend): Invalid card object', card);
      return false;
  }

  // Card values, excluding 8, 9, 10
  const values = {
    '2': 2, '3': 3, '4': 4, '5': 5,
    '6': 6, '7': 7, J: 11, Q: 12,
    K: 13, ace: 1 // Ace value is 1 for sorting
  };

  // Check if it's a same-rank spread
  const isSameRankSpread = spread.every(c => c.rank === spread[0].rank);
  if (isSameRankSpread) {
      // If it's a same-rank spread, the hit card must match the rank
      if (card.rank === spread[0].rank) {
          console.log('isValidHit (backend): Valid hit on same-rank spread');
          return true;
      } else {
          console.log('isValidHit (backend): Invalid rank for same-rank hit');
          return false;
      }
  }

  // Check if it's a suited sequence spread
  const isSuitedSequenceSpread = spread.every(c => c.suit === spread[0].suit);

  if (isSuitedSequenceSpread) {
      // If it's a suited sequence spread, the hit card must match the suit
      if (card.suit !== spread[0].suit) {
          console.log('isValidHit (backend): Invalid suit for suited sequence hit');
          return false;
      }

      // Collect all ranks (spread + hit card) and map to values
      const rankSequenceOrder = ['ace', '2', '3', '4', '5', '6', '7', 'J', 'Q', 'K'];
      const getRankIndex = (rank) => rankSequenceOrder.indexOf(rank);

      const allRanks = [...spread.map(c => c.rank), card.rank];
      const allRankIndices = allRanks.map(rank => getRankIndex(rank)).sort((a, b) => a - b);

      // Check for standard consecutive sequence based on rankSequenceOrder
      let isSequence = true;
      for (let i = 1; i < allRankIndices.length; i++) {
          if (allRankIndices[i] === -1 || allRankIndices[i - 1] === -1 || allRankIndices[i] !== allRankIndices[i - 1] + 1) {
              isSequence = false;
              break;
          }
      }

      if (isSequence) {
           console.log('isValidHit (backend): Valid hit on suited sequence (standard)');
           return true;
      }

      // If it's a suited sequence but doesn't form a valid standard or Ace-low sequence
      console.log('isValidHit (backend): Invalid rank sequence for suited sequence hit', allRankIndices);
      return false;

  }

  // If it's neither a same-rank nor a suited sequence spread, it's not a valid target
  console.log('isValidHit (backend): Spread is neither same-rank nor suited sequence');
  return false;

};


const findBestHit = (hand, playerSpreads) => {
  for (let cardIndex = 0; cardIndex < hand.length; cardIndex++) {
    const card = hand[cardIndex];

    for (let targetIndex = 0; targetIndex < playerSpreads.length; targetIndex++) {
      const spreads = playerSpreads[targetIndex];
      for (let spreadIndex = 0; spreadIndex < spreads.length; spreadIndex++) {
        const spread = spreads[spreadIndex];
        if (isValidHit(card, spread)) {
          return { cardIndex, targetIndex, spreadIndex };
        }
      }
    }
  }

  return null;
};

const initializeGameState = (table) => {
  console.log(`🎮 initializeGameState: Creating completely fresh game state for table ${table._id}`);
  console.log(`🎮 initializeGameState: Previous gameState was:`, table.gameState ? 'exists' : 'null');
  
  const deck = shuffleDeck([...initialDeck]);
  const hands = dealHands(deck, table.players.length);

  console.log('🎮 initializeGameState: Players:', table.players.map(p => ({ username: p.username, isHuman: p.isHuman })));

  // ✅ Create completely new game state object
  table.gameState = {
    // ✅ Ensure players array preserves exact usernames
    players: table.players.map(p => ({
      username: p.username, // Preserve exact username
      chips: p.chips,
      isHuman: p.isHuman,
      socketId: p.socketId,
      joinedAt: p.joinedAt,
      status: p.status,
      position: p.position
    })),
    deck,
    playerHands: hands,
    playerSpreads: Array.from({ length: table.players.length }, () => []),
    discardPile: [],
    currentTurn: 0,
    hasDrawnCard: false,
    gameOver: false,
    gameStarted: true, // Mark game as started
    winners: [],
    winType: null,
    timestamp: Date.now(),
    stake: table.stake,
    pot: table.stake * table.players.length,
    roundScores: [],
    isInitialized: true,
    isLoading: false
  };

  // Check for immediate 50-point win after dealing hands
  const initialScores = table.gameState.playerHands.map((hand, index) =>
    calculatePoints(hand, table.gameState.playerSpreads[index] || [])
  );

  const playerWith50 = initialScores.findIndex(score => score === 50);
  if (playerWith50 !== -1) {
    console.log(`🏆 IMMEDIATE 50 WIN: Player ${table.gameState.players[playerWith50].username} has 50 points exactly!`);
    table.gameState.gameOver = true;
    table.gameState.winners = [playerWith50];
    table.gameState.winType = 'IMMEDIATE_50_WIN';
    table.gameState.roundScores = initialScores;
    console.log(`🟢 END GAME TRIGGERED: IMMEDIATE_50_WIN`);
  }

  console.log('🎮 initializeGameState: Game state initialized with players:', table.gameState.players.map(p => ({ username: p.username, isHuman: p.isHuman })));
  console.log('🎮 initializeGameState: Player hands dealt:', table.gameState.playerHands.map((hand, i) => ({ player: table.gameState.players[i].username, cardCount: hand.length })));
  console.log(`🎮 initializeGameState: Fresh state created - gameOver: ${table.gameState.gameOver}, gameStarted: ${table.gameState.gameStarted}, timestamp: ${table.gameState.timestamp}`);
};

const processGameAction = (state, action, payload) => {
  const newState = { ...state };
  const currentTurn = newState.currentTurn;
  const playerHand = newState.playerHands?.[currentTurn] || [];

  console.log(`⚙️ processGameAction: Processing ${action} for player ${newState.players[currentTurn].username} (turn ${currentTurn})`);
  console.log(`⚙️ processGameAction: Before action - gameOver: ${newState.gameOver}, hand size: ${playerHand.length}`);
  
  // ✅ Ensure playerSpreads is always properly initialized
  if (!newState.playerSpreads || !Array.isArray(newState.playerSpreads)) {
    console.log(`⚙️ processGameAction: Initializing playerSpreads array`);
    newState.playerSpreads = Array.from({ length: newState.players.length }, () => []);
  }

  switch (action) {
    case 'DRAW_CARD':
      if (!newState.hasDrawnCard && newState.deck?.length > 0) {
        const card = newState.deck.pop();
        newState.playerHands[currentTurn].push(card);
        newState.hasDrawnCard = true;

        if (newState.deck.length === 0 && !newState.gameOver) {
          const finalScores = newState.playerHands.map((hand, index) =>
            calculatePoints(hand, newState.playerSpreads[index] || [])
          );
          const minScore = Math.min(...finalScores);
          const winners = finalScores
            .map((score, index) => ({ score, index }))
            .filter(({ score }) => score === minScore)
            .map(({ index }) => index);

          console.log(`🏆 STOCK_EMPTY WIN: Deck empty, winners: [${winners.join(',')}], scores: [${finalScores.join(',')}]`);
          newState.gameOver = true;
          newState.winners = winners;
          newState.winType = 'STOCK_EMPTY';
          newState.roundScores = finalScores;
          console.log(`🟢 END GAME TRIGGERED: STOCK_EMPTY`);
        }

      }
      break;

    case 'DRAW_DISCARD':
      if (!newState.hasDrawnCard && newState.discardPile?.length > 0) {
        const card = newState.discardPile.pop();
        newState.playerHands[currentTurn].push(card);
        newState.hasDrawnCard = true;

      }
      break;

      case 'DISCARD':
        if (!newState.hasDrawnCard || payload.cardIndex === undefined) break;

        const discarded = newState.playerHands[currentTurn].splice(payload.cardIndex, 1)[0];
        newState.discardPile.push(discarded);
        newState.hasDrawnCard = false;
        newState.currentTurn = (currentTurn + 1) % newState.players.length;

        // ✅ Preserve playerSpreads — nothing else needed here

        // Check win condition
        if (newState.playerHands[currentTurn].length === 0) {
          console.log(`🏆 REGULAR WIN: Player ${newState.players[currentTurn].username} has 0 cards after discard`);
          newState.gameOver = true;
          newState.winners = [currentTurn];
          newState.winType = 'REGULAR_WIN';
          console.log(`🟢 END GAME TRIGGERED: REGULAR_WIN`);
        }
        break;


      case 'SPREAD':
        console.log(`⚙️ SPREAD: Processing spread for player ${newState.players[currentTurn].username}`);
        console.log(`⚙️ SPREAD: Payload cards:`, payload.cards);
        console.log(`⚙️ SPREAD: Current playerSpreads:`, newState.playerSpreads);
        
        if (!Array.isArray(payload.cards)) {
          console.log(`⚙️ SPREAD: Invalid payload - not array`);
          break;
        }
        
        const isValid = isValidSpread(payload.cards);
        console.log(`⚙️ SPREAD: Spread validity:`, isValid);
        
        if (!isValid) {
          console.log(`⚙️ SPREAD: Invalid spread, breaking`);
          break;
        }

        // Ensure playerSpreads array exists and is properly initialized
        if (!newState.playerSpreads) {
          console.log(`⚙️ SPREAD: Initializing playerSpreads array`);
          newState.playerSpreads = Array.from({ length: newState.players.length }, () => []);
        }

        const spreadClone = newState.playerSpreads[currentTurn]?.slice() || [];
        spreadClone.push([...payload.cards]); // Deep clone the cards
        console.log(`⚙️ SPREAD: Updated spreads for player ${currentTurn}:`, spreadClone);

        // Replace entire spread array for immutability
        newState.playerSpreads = newState.playerSpreads.map((spreads, i) =>
          i === currentTurn ? spreadClone : spreads
        );

        console.log(`⚙️ SPREAD: Hand before removing cards:`, newState.playerHands[currentTurn]);
        payload.cards.forEach(card => {
          const idx = newState.playerHands[currentTurn].findIndex(
            c => c.rank === card.rank && c.suit === card.suit
          );
          if (idx !== -1) {
            console.log(`⚙️ SPREAD: Removing card at index ${idx}:`, card);
            newState.playerHands[currentTurn].splice(idx, 1);
          }
        });
        console.log(`⚙️ SPREAD: Hand after removing cards:`, newState.playerHands[currentTurn]);

        const spreadCount = newState.playerSpreads[currentTurn].length;
        console.log(`⚙️ SPREAD: Player ${currentTurn} now has ${spreadCount} spreads`);
        
        if (spreadCount === 2) {
          console.log(`🏆 REEM WIN: Player ${newState.players[currentTurn].username} achieved REEM with ${spreadCount} spreads`);
          newState.gameOver = true;
          newState.winners = [currentTurn];
          newState.winType = 'REEM';
          console.log(`🟢 END GAME TRIGGERED: REEM`);
        }
        
        console.log(`⚙️ SPREAD: Final playerSpreads state:`, newState.playerSpreads);
        break;

    case 'HIT':
        const { cardIndex, targetIndex, spreadIndex } = payload;
        const cardToHit = newState.playerHands[currentTurn][cardIndex];
        const targetSpread = newState.playerSpreads?.[targetIndex]?.[spreadIndex];
    
        if (isValidHit(cardToHit, targetSpread)) {
            newState.playerHands[currentTurn].splice(cardIndex, 1);
            newState.playerSpreads[targetIndex][spreadIndex].push(cardToHit);
    
            // Apply penalty
            const targetPlayer = newState.players[targetIndex];
            if (!targetPlayer.hitCount) {
                targetPlayer.hitCount = 0;
            }
            targetPlayer.hitCount++;
            targetPlayer.hitPenaltyRounds = (targetPlayer.hitCount === 1) ? 2 : 1;
    
            newState.hasDrawnCard = false;
            newState.currentTurn = (currentTurn + 1) % newState.players.length;
        } else {
            newState.currentTurn = (currentTurn + 1) % newState.players.length;
        }
        break;


      case 'DROP':
          const dropperPlayer = newState.players[currentTurn];
          if (dropperPlayer.hitPenaltyRounds > 0) {
              // Player cannot drop, maybe send an event to notify the client
              break;
          }
          // Calculate scores excluding spread cards
          const scores = newState.playerHands.map((hand, index) =>
            calculatePoints(hand, newState.playerSpreads[index] || [])
          );
          const min = Math.min(...scores);
          const dropper = scores[currentTurn];
          const winners = scores.map((score, i) => (score === min ? i : null)).filter(i => i !== null);
          newState.gameOver = true;
          newState.winners = winners;
          newState.winType = dropper > min ? 'DROP_CAUGHT' : 'DROP_WIN';
          newState.dropped = currentTurn;
          newState.roundScores = scores; // Store final scores
          console.log(`🟢 END GAME TRIGGERED: DROP (${newState.winType})`);
          break;

      case 'DECLARE_SPECIAL_WIN':
          console.log(`🏆 DECLARE_SPECIAL_WIN: Player ${newState.players[currentTurn].username} attempting special win`);
          const currentPlayerScore = calculatePoints(playerHand, newState.playerSpreads[currentTurn] || []);
          
          // Check for 41 points or less than 11 points (i.e., 10 or less)
          if (currentPlayerScore === 41 || currentPlayerScore <= 10) {
              console.log(`🏆 SPECIAL WIN: Player ${newState.players[currentTurn].username} declared special win with score ${currentPlayerScore}`);
              newState.gameOver = true;
              newState.winners = [currentTurn];
              newState.winType = 'SPECIAL_WIN';
              newState.roundScores = newState.playerHands.map((hand, index) =>
                calculatePoints(hand, newState.playerSpreads[index] || [])
              );
              console.log(`🟢 END GAME TRIGGERED: SPECIAL_WIN`);
          } else {
              console.log(`🚫 DECLARE_SPECIAL_WIN: Invalid score for special win: ${currentPlayerScore}`);
              // Optionally, could add a penalty or just ignore the action
          }
          break;

      default:
        console.warn(`Unhandled game action: ${action}`);
        break;
    }


  console.log(`⚙️ processGameAction: After ${action} - gameOver: ${newState.gameOver}, winType: ${newState.winType}, winners: [${newState.winners?.join(',') || ''}]`);

  // After any action that might end the game, check for AI departure conditions
  if (newState.gameOver) {
    handleAiDeparture(newState);
  }

  return newState;
};

const handleAiDeparture = (gameState) => {
  const humanPlayers = gameState.players.filter(p => p.isHuman);
  const aiPlayers = gameState.players.filter(p => !p.isHuman);

  // Condition 1: If there are 2 or more human players, AI leaves
  if (humanPlayers.length >= 2 && aiPlayers.length > 0) {
    console.log(`🤖 AI Departure: Game over with ${humanPlayers.length} human players. AI(s) will leave.`);
    // Remove all AI players
    gameState.players = gameState.players.filter(p => p.isHuman);
    // Re-index playerHands and playerSpreads to match new player array
    const newPlayerHands = [];
    const newPlayerSpreads = [];
    gameState.players.forEach(humanPlayer => {
      const originalIndex = gameState.players.findIndex(p => p.username === humanPlayer.username);
      if (originalIndex !== -1) {
        newPlayerHands.push(gameState.playerHands[originalIndex]);
        newPlayerSpreads.push(gameState.playerSpreads[originalIndex]);
      }
    });
    gameState.playerHands = newPlayerHands;
    gameState.playerSpreads = newPlayerSpreads;
    // Reset currentTurn if the current player was an AI that left
    if (!gameState.players[gameState.currentTurn]?.isHuman) {
      gameState.currentTurn = 0; // Or find the next human player
    }
  }
  // Condition 2: If there is only human vs AI at a table and the human leaves, the AI needs to leave as well
  // This condition is typically handled by the player leaving logic, not game end.
  // However, if a human player leaves and it results in only one human and one AI, and then the game ends,
  // the above condition (humanPlayers.length >= 2) would not apply.
  // This specific scenario (human leaves, then AI leaves if only human vs AI) needs to be handled
  // where player disconnections are processed, likely in useWebSocket.js or gameActions.js.
  // For now, I'll assume this function is called only when the game *ends*.
  // If a human leaves mid-game, the game state would be updated elsewhere, and then if the game ends,
  // the above logic would apply.

  console.log(`🤖 AI Departure: After check - remaining players:`, gameState.players.map(p => p.username));
};






const calculateStateHash = (state) => {
  const normalized = JSON.stringify(state, Object.keys(state).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
};


module.exports = {
  createDeck,
  shuffleDeck,
  dealHands,
  calculatePoints,
  isValidSpread,
  isValidHit, // Export the corrected function
  initializeGameState,
  processGameAction,
  calculateStateHash,
  findBestSpread,
  findBestHit,

};
