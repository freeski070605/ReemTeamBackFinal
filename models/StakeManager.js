const calculateStakeWinnings = (winType, stake, playerCount) => {
    switch(winType) {
        case 'REEM':
            return stake * 2 * (playerCount - 1); // Double stake from each player
        case 'DROP_WIN':
            return stake * (playerCount - 1);
        case 'DROP_CAUGHT':
            return -stake * (playerCount - 1); // Player pays others
        case 'REGULAR_WIN':
            return stake * (playerCount - 1);
        case 'TIE':
            return stake; // Split pot between tied players
        default:
            return 0;
    }
};
