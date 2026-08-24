function generateAgoraUid(userId) {
    let hash = 0;

    const value = String(userId);

    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) - hash + value.charCodeAt(i);
        hash |= 0;
    }

    // Make positive
    hash = Math.abs(hash);

    // Keep within safe Agora UID range
    return (hash % 2147483646) + 1;
}

module.exports = {
    generateAgoraUid
};