import { createClient } from 'redis';

export type RedisClient = ReturnType<typeof createClient>;

export type RedisCredential = {
	host: string;
	port: number;
	ssl?: boolean;
	database: number;
	user?: string;
	password?: string;
};

export type BufferState = {
	exp: number;
	data: any[];
};
