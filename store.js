const businesses = [];
module.exports = {
  getAll: () => businesses,
  add: (biz) => businesses.push(biz),
  clear: () => { businesses.length = 0; }
};