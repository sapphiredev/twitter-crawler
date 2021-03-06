import {
	Database,
	GoogleAuth,
	GoogleSpreadsheets,
	Puppeteer,
	TweetDeck,
} from '~/server/libs';

import {
	Command,
	CredentialsType,
} from '~/shared/models';

import {
	sleep,
} from '~/shared/helpers';

const DRIVE_ID = '1LBftZfGtRYSfNF0azqN3t0u1dNPy05ta';
const SHEETS_ID = '14ls6Zi-78B_pGqKEe_f4qrP_7HL5zkKoKU5ofrGR9Pk';

export class App {
	private static instance: App | null = null;

	private shouldProcess: boolean = false;
	private queue: Command[] = [];

	private constructor() {}

	public static createInstance() {
		if(this.instance !== null) {
			throw new Error('cannot create app instance');
		}
		this.instance = new App();
	}

	public static getInstance() {
		if(this.instance === null) {
			throw new Error('app instance is not created');
		}
		return this.instance;
	}

	public async initialize() {
		{
			const googleAuth = new GoogleAuth(CredentialsType.SPREADSHEETS);
			const auth = await googleAuth.initialize();
			if(auth === null) {
				return;
			}
			GoogleSpreadsheets.createInstance(auth, SHEETS_ID);
		}

		{
			Database.createInstance();
		}

		{
			const spreadsheets = GoogleSpreadsheets.getInstance();
			const database = Database.getInstance();

			const manifest = await spreadsheets.getManifest();

			Puppeteer.createInstance(manifest);
			await database.initialize(manifest);
		}

		{
			const puppeteer = Puppeteer.getInstance();
			const config = await puppeteer.initialize();

			TweetDeck.createInstance(config);
		}

		{
			const puppeteer = Puppeteer.getInstance();
			await puppeteer.close();
		}
	}

	private async process(command: Command) {
		console.log(command);
	}

	public pushQueue(command: Command) {
		this.queue.push(command);
	}

	public async stop() {
		this.shouldProcess = false;
	}

	private async addUsers() {
		const database = Database.getInstance();
		const tweetdeck = TweetDeck.getInstance();

		const ids = await tweetdeck.getUserIDs();
		console.log(`user ids fetched: ${ids.length}`);

		await database.insertUsers(ids);
	}

	private async updateUsers() {
		const database = Database.getInstance();
		const tweetdeck = TweetDeck.getInstance();

		const userEntities = await database.selectUsers();

		for(const userEntity of userEntities) {
			const {
				id,
			} = userEntity;

			{
				const {
					name,
					screen_name,
				} = userEntity;

				if(name !== '' && screen_name !== '') {
					continue;
				}
			}

			const user = await tweetdeck.getUser(id);

			const {
				screen_name,
				name,
			} = user;

			console.log(`user fetched: ${name} ${screen_name}`);

			await database.updateUser({
				'id': userEntity.id,
				'screen_name': screen_name,
				'name': name,
			});

			await sleep(50);
		}
	}

	private async syncUsers() {
		const database = Database.getInstance();
		const spreadsheets = GoogleSpreadsheets.getInstance();

		const userEntities = await database.selectUsers();

		const users = await spreadsheets.getUsers();
		if(users === null) {
			throw new Error(`users sheet does not exist`);
		}

		await spreadsheets.appendUsers(userEntities.filter((userEntity) => {
			return users.find((user) => {
				return user.id === userEntity.id;
			}) === null;
		}));

		for(const userEntity of userEntities) {
			if(userEntity.alias !== '') {
				continue;
			}

			const user = users.find((user) => {
				return user.id === userEntity.id;
			});
			if(user === null || user.alias === '') {
				continue;
			}

			await database.updateUser({
				'id': userEntity.id,
				'alias': user.alias,
			});
		}
	}

	private async fetchTweets() {
		const database = Database.getInstance();
		const tweetdeck = TweetDeck.getInstance();

		const now = Date.now();

		const users = (await database.selectUsers()).filter((user) => {
			return now > user.crawled_at + 24 * 60 * 60 * 1000;
		});
		for(const user of users) {
			console.log(`crawl user: ${user.screen_name}`);

			let maxID: string | undefined;
			let shouldProcess = true;
			do {
				try {
					if(maxID === undefined) {
						maxID = await database.selectTweet(user.id);
					}

					const tweets = await tweetdeck.getTweets(user.screen_name, maxID);
					console.log(`max id: ${maxID}`);
					console.log(`tweets crawled: ${tweets.length}`);

					if(tweets.length <= 1) {
						shouldProcess = false;
						break;
					}

					await database.insertTweets(tweets);

					maxID = tweets[tweets.length - 1].id_str;

					await sleep(200);
				}
				catch(err) {
					console.log(err);
					shouldProcess = true;
					maxID = undefined;
					continue;
				}
			}
			while(shouldProcess);

			await database.updateUser({
				'id': user.id,
				'crawled_at': Date.now(),
			});

			await sleep(50);
		}
	}

	public async start() {
		this.shouldProcess = true;

		do {
			await this.addUsers();
			await sleep(50);

			await this.updateUsers();
			await sleep(50);

			await this.syncUsers();
			await sleep(50);

			await this.fetchTweets();
			await sleep(50);

			await sleep(60 * 1000);
		}
		while(this.shouldProcess);

		const database = Database.getInstance();
		await database.close();
	}
}
