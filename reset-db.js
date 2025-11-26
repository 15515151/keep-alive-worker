const redis = require('redis');
require('dotenv').config();

async function resetDatabase() {
  const client = redis.createClient({
    url: `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`
  });

  try {
    await client.connect();
    console.log('已连接到Redis');
    
    // 清空所有数据
    await client.flushDb();
    console.log('数据库已重置，所有数据已清空');
    
    await client.disconnect();
    console.log('已断开Redis连接');
  } catch (error) {
    console.error('重置数据库失败:', error);
  }
}

resetDatabase();