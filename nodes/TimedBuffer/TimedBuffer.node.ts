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
		icon: 'file:timedbuffer.svg',
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
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Avoid Key Collisions',
						description: 'Whether to prevent key collisions when used across multiple workflows',
						name: 'avoidCollisions',
						type: 'boolean',
						default: true,
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resumeItems: INodeExecutionData[] = [];
		const skippedItems: INodeExecutionData[] = [];
		const credentials = await this.getCredentials<RedisCredential>('redis');
		const redisClient = setupRedisClient(credentials);

		let key = this.getNodeParameter('sessionkey', 0);
		const content = this.getNodeParameter('content', 0);
		let waitAmount = this.getNodeParameter('amount', 0) as number;
		const unit = this.getNodeParameter('unit', 0);
		const { avoidCollisions } = this.getNodeParameter('options', 0) as { avoidCollisions?: boolean };

		if (avoidCollisions) {
			const { id } = this.getWorkflow();
			// Add the workflow ID to the key to avoid collisions when the same key is used across different workflows
			key = id! + key
		}

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

		const getBufferState = async (): Promise<BufferState | null> => {
			try {
				const val = await redisClient.get(key);
				if (!val) return null;
				return JSON.parse(val) as BufferState;
			} catch (e) {
				return null;
			}
		};

		try {
			await redisClient.connect();

			this.onExecutionCancellation(async () => {
				await redisClient.del(key);
				await redisClient.quit();
			});

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
					await new Promise((resolve) => {
						const timer = setTimeout(resolve, waitAmount);
						this.onExecutionCancellation(() => clearTimeout(timer));
					});
				}

				const buffer = await getBufferState();
				resumeItems.push({ json: { data: buffer!.data } });
				await redisClient.del(key);
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
			}
			throw new NodeOperationError(this.getNode(), error);
		} finally {
			await redisClient.quit();
		}

		return [resumeItems, skippedItems];
	}
}
