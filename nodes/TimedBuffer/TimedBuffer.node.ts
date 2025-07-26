import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';
import type { RedisCredential, BufferState } from './type';
import { setupRedisClient } from './utils';

export class TimedBuffer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Timed Buffer',
		name: 'timedBuffer',
		icon:'file:timedbuffer.svg',
		group: ['transform'],
		version: 1,
		description:
			'Node that queues incoming string data and outputs it all at once after a defined time has passed',
		defaults: {
			name: 'Timed Buffer',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main, NodeConnectionType.Main],
		outputNames: ['Resume', 'Skipped'],
		credentials: [
			{
				name: 'redis',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Session Key',
				name: 'sessionkey',
				type: 'string',
				required: true,
				default: '',
				placeholder: '11b0de85-babd-43ac-b1a2-b65c766597a1',
				description: 'Unique identifier for a set of messages',
			},
			{
				displayName: 'Content',
				name: 'content',
				type: 'string',
				default: '',
				placeholder: 'Any string',
				description: 'Any data of type string',
			},
			{
				displayName: 'Wait Amount',
				name: 'amount',
				type: 'number',
				typeOptions: {
					minValue: 0,
					numberPrecision: 2,
				},
				default: 0,
				description: 'Time to wait after the last input data',
			},
			{
				displayName: 'Wait Unit',
				name: 'unit',
				type: 'options',
				options: [
					{
						name: 'Seconds',
						value: 'seconds',
					},
					{
						name: 'Minutes',
						value: 'minutes',
					},
					{
						name: 'Hours',
						value: 'hours',
					},
					{
						name: 'Days',
						value: 'days',
					},
				],
				default: 'seconds',
				description: 'The time unit of the Wait Amount value',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		const resumeItems: INodeExecutionData[] = [];
		const skippedItems: INodeExecutionData[] = [];
		const credentials = await this.getCredentials<RedisCredential>('redis');

		if (!credentials) {
			throw new Error('Redis credentials are not configured for this node.');
		}

		const redisClient = setupRedisClient(credentials);
		await redisClient.connect();

		for (let i = 0; i < items.length; i++) {
			try {
				const key = this.getNodeParameter('sessionkey', i);
				const content = this.getNodeParameter('content', i);
				let waitAmount = this.getNodeParameter('amount', i) as number;
				const unit = this.getNodeParameter('unit', i);

				const getBufferState = async (): Promise<BufferState | null> => {
					try {
						const val = await redisClient.get(key);
						if (!val) return null;
						return JSON.parse(val) as BufferState;
					} catch (e) {
						return null;
					}
				};

				if (unit === 'minutes') {
					waitAmount *= 60;
				}
				if (unit === 'hours') {
					waitAmount *= 60 * 60;
				}
				if (unit === 'days') {
					waitAmount *= 60 * 60 * 24;
				}

				waitAmount *= 1000;

				const existsBuffer = await getBufferState();

				if (!existsBuffer) {
					let bufferState = {
						exp: Date.now() + waitAmount,
						data: [content],
					};

					await redisClient.set(key, JSON.stringify(bufferState));

					let resume = false;
					while (!resume) {
						const refreshBuffer = await getBufferState();

						if (!refreshBuffer) {
							throw new Error(
								`Error retrieving buffer state from Redis. Key: "${key}".` +
									' Possible causes: nonexistent key, invalid JSON value, or connection error.',
							);
						}

						waitAmount = Math.max(0, refreshBuffer.exp - Date.now());
						resume = waitAmount === 0;
						if (resume) break;
						await new Promise((resolve) => setTimeout(resolve, waitAmount));
					}

					const buffer = await getBufferState();
					await redisClient.del(key);
					resumeItems.push({ json: { data: buffer!.data } });
				} else {
					const { data } = existsBuffer;
					data.push(content);
					let bufferState = {
						exp: Date.now() + waitAmount,
						data,
					};

					await redisClient.set(key, JSON.stringify(bufferState));
					skippedItems.push({ json: {} });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					resumeItems.push({
						json: {
							error: error.message,
						},
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
			}
		}

		await redisClient.quit();
		return [resumeItems, skippedItems];
	}
}
