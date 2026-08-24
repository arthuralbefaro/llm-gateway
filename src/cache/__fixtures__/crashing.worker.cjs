// kills its own thread on demand, so the pool's recovery can be exercised
// against a real dead worker rather than a mocked one
module.exports = ({ text }) => {
  if (text === 'crash') {
    process.exit(1);
  }
  return [0.1, 0.2, 0.3];
};
