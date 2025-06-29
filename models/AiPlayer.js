const { findBestSpread, findBestHit, calculatePoints, isValidHit } = require('./gameLogic');

const runAiTurn = (gameState) => {
  const newState = { ...gameState };
  const playerIndex = newState.currentTurn;
  const player = newState.players[playerIndex];

  console.log(`🤖 AI Turn: Player ${player.username} (index ${playerIndex}), gameOver: ${newState.gameOver}`);

  if (player.isHuman || newState.gameOver) {
    console.log(`🤖 AI Turn: Early return - isHuman: ${player.isHuman}, gameOver: ${newState.gameOver}`);
    return newState;
  }

  const hand = newState.playerHands[playerIndex];
  const spreads = newState.playerSpreads[playerIndex] || [];

  // Draw
  const topDiscard = newState.discardPile.length > 0 ? newState.discardPile[newState.discardPile.length - 1] : null;
  const canUseDiscard = topDiscard && isValidHit(topDiscard, spreads.length > 0 ? spreads[0] : []);
  
  if (canUseDiscard) {
    const card = newState.discardPile.pop();
    hand.push(card);
  } else if (newState.deck.length > 0) {
    const card = newState.deck.pop();
    hand.push(card);
  }
  newState.hasDrawnCard = true;

  // Spread
  const bestSpread = findBestSpread(hand);
  if (bestSpread) {
    spreads.push(bestSpread);
    bestSpread.forEach(card => {
      const i = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
      if (i !== -1) hand.splice(i, 1);
    });

    if (spreads.length >= 2) {
      console.log(`🏆 AI REEM WIN: Player ${player.username} achieved REEM with ${spreads.length} spreads`);
      newState.gameOver = true;
      newState.winners = [playerIndex];
      newState.winType = 'REEM';
      console.log(`🏆 AI REEM WIN: Setting gameOver = true, winners = [${playerIndex}], winType = REEM`);
      return newState;
    }
  }

  // Hit
  const hitInfo = findBestHit(hand, newState.playerSpreads);
  if (hitInfo) {
    const { cardIndex, targetIndex, spreadIndex } = hitInfo;
    const card = hand.splice(cardIndex, 1)[0];
    newState.playerSpreads[targetIndex][spreadIndex].push(card);
  }

  // Drop
  const score = calculatePoints(hand, spreads);
  if (score <= 5) {
    const allScores = newState.playerHands.map((h, i) =>
      calculatePoints(h, newState.playerSpreads[i] || [])
    );
    const minScore = Math.min(...allScores);
    const winners = allScores.map((s, i) => s === minScore ? i : null).filter(i => i !== null);

    console.log(`🏆 AI DROP WIN: Player ${player.username} dropping with score ${score}, minScore: ${minScore}`);
    newState.gameOver = true;
    newState.winners = winners;
    newState.winType = score > minScore ? 'DROP_CAUGHT' : 'DROP_WIN';
    newState.dropped = playerIndex;
    newState.roundScores = allScores;
    console.log(`🏆 AI DROP WIN: Setting gameOver = true, winners = [${winners.join(',')}], winType = ${newState.winType}`);
    return newState;
  }

  // Discard
  const worstIndex = hand.reduce((maxIdx, c, i, arr) => {
      const values = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, J: 10, Q: 10, K: 10, ace: 1 };
      const currentValue = values[c.rank] || 0;
      const maxCurrentValue = values[arr[maxIdx].rank] || 0;
      return currentValue > maxCurrentValue ? i : maxIdx;
  }, 0);

  const discard = hand.splice(worstIndex, 1)[0];
  newState.discardPile.push(discard);
  newState.hasDrawnCard = false;
  newState.currentTurn = (playerIndex + 1) % newState.players.length;

  console.log(`🤖 AI Turn Complete: Player ${player.username} discarded ${discard.rank} of ${discard.suit}, next turn: ${newState.currentTurn}`);
  
  // Check if AI has 0 cards after discard (regular win)
  if (hand.length === 0) {
    console.log(`🏆 AI REGULAR WIN: Player ${player.username} has 0 cards after discard`);
    newState.gameOver = true;
    newState.winners = [playerIndex];
    newState.winType = 'REGULAR_WIN';
    console.log(`🏆 AI REGULAR WIN: Setting gameOver = true, winners = [${playerIndex}], winType = REGULAR_WIN`);
  }

  return newState;
};

module.exports = { runAiTurn };
