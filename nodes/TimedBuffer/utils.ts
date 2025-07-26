import { createClient } from 'redis';
import { RedisClient, RedisCredential } from './type';

export const setupRedisClient = (credentials: RedisCredential): RedisClient => {
	return createClient({
		socket: {
			host: credentials.host,
			port: credentials.port,
			tls: credentials.ssl === true,
		},
		database: credentials.database,
		username: credentials.user || undefined,
		password: credentials.password || undefined,
	});
};
