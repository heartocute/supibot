module.exports = {
	Name: "gpt",
	Aliases: ["chatgpt"],
	Author: "supinic",
	Cooldown: 30000,
	Description: "Queries ChatGPT for a text response. Supports multiple models and parameter settings. Limited by tokens usage!",
	Flags: ["mention","non-nullable","pipe"],
	Params: [
		{ name: "history", type: "boolean" },
		{ name: "model", type: "string" },
		{ name: "limit", type: "number" },
		{ name: "temperature", type: "number" }
	],
	Whitelist_Response: "Currently only available in these channels for testing: @pajlada @Supinic @Supibot",
	Static_Data: null,
	Code: (async function chatGPT (context, ...args) {
		const ChatGptConfig = require("./config.json");
		const GptCache = require("./cache-control.js");
		const GptHistory = require("./history-control.js");

		const query = args.join(" ").trim();
		if (!query) {
			return {
				success: false,
				reply: "You have not provided any text!",
				cooldown: 2500
			};
		}

		const [defaultModelName] = Object.entries(ChatGptConfig.models).find(i => i[1].default === true);
		const customOutputLimit = context.params.limit;
		const modelName = (context.params.model)
			? context.params.model.toLowerCase()
			: defaultModelName;

		const modelData = ChatGptConfig.models[modelName];
		if (!modelData) {
			const names = Object.keys(ChatGptConfig.models).sort().join(", ");
			return {
				success: false,
				cooldown: 2500,
				reply: `Invalid ChatGPT model supported! Use one of: ${names}`
			};
		}
		else if (modelData.disabled) {
			return {
				success: false,
				reply: `That model is currently disabled! Reason: ${modelData.disableReason ?? "(N/A)"}`
			};
		}

		let promptPrefix = "";
		if (context.params.history) {
			const historicPrompt = await GptHistory.dump(context.user, query);
			if (historicPrompt.length !== 0) {
				promptPrefix = `${historicPrompt.join("\n\n")}\n`;
			}
		}

		const { queryNames } = ChatGptConfig;
		const prompt = `${promptPrefix}${queryNames.prompt}: ${query}\n${queryNames.response}: `;

		if (modelData.inputLimit && prompt.length > modelData.inputLimit) {
			const messages = ChatGptConfig.lengthLimitExceededMessage;
			const message = (promptPrefix) ? messages.history : messages.regular;

			return {
				success: false,
				cooldown: 2500,
				reply: `${message} ${prompt.length}/${modelData.inputLimit}`
			};
		}
		else if (!modelData.inputLimit && prompt.length > ChatGptConfig.globalInputLimit) {
			return {
				success: false,
				cooldown: 2500,
				reply: `Maximum query length exceeded! ${prompt.length}/${ChatGptConfig.globalInputLimit}`
			};
		}

		const { temperature } = context.params;
		if (typeof temperature === "number" && (temperature < 0 || temperature > 2)) {
			return {
				success: false,
				reply: `Your provided temperature is outside of the valid range! Use a value between 0.0 and 2.0 - inclusive.`,
				cooldown: 2500
			};
		}

		const limitCheckResult = await GptCache.checkLimits(context.user);
		if (limitCheckResult.success !== true) {
			return limitCheckResult;
		}

		let outputLimit = modelData.outputLimit.default;
		if (typeof customOutputLimit === "number") {
			if (!sb.Utils.isValidInteger(customOutputLimit)) {
				return {
					success: false,
					reply: `Your provided output limit must be a positive integer!`,
					cooldown: 2500
				};
			}

			const maximum = modelData.outputLimit.maximum;
			if (customOutputLimit > maximum) {
				return {
					success: false,
					cooldown: 2500,
					reply: `
						Maximum output limit exceeded for this model!
						Lower your limit, or use a lower-ranked model instead.
						${customOutputLimit}/${maximum}
					`
				};
			}

			outputLimit = customOutputLimit;
		}

		// @todo remove this try-catch and make the method return `null` with some param
		let userPlatformID;
		try {
			userPlatformID = context.platform.fetchInternalPlatformIDByUsername(context.user);
		}
		catch {
			userPlatformID = "N/A";
		}

		const { createHash } = require("crypto");
		const userHash = createHash("sha1")
			.update(context.user.Name)
			.update(context.platform.Name)
			.update(userPlatformID)
			.digest()
			.toString("hex");

		const response = await sb.Got("GenericAPI", {
			method: "POST",
			throwHttpErrors: false,
			url: `https://api.openai.com/v1/completions`,
			headers: {
				Authorization: `Bearer ${sb.Config.get("API_OPENAI_KEY")}`
			},
			json: {
				model: modelData.url,
				prompt,
				max_tokens: outputLimit,
				temperature: temperature ?? ChatGptConfig.defaultTemperature,
				top_p: 1,
				frequency_penalty: 0,
				presence_penalty: 0,
				user: userHash
			}
		});

		if (!response.ok) {
			const logID = await sb.Logger.log(
				"Command.Warning",
				`ChatGPT API fail: ${response.statusCode} → ${JSON.stringify(response.body)}`,
				context.channel,
				context.user
			);

			if (response.statusCode === 429 && response.body.error.type === "insufficient_quota") {
				const { year, month } = new sb.Date();
				const nextMonthName = new sb.Date(year, month + 1, 1).format("F Y");
				const nextMonthDelta = sb.Utils.timeDelta(sb.Date.UTC(year, month + 1, 1));

				return {
					success: false,
					reply: sb.Utils.tag.trim `
						I have ran out of credits for the ChatGPT service for this month!
						Please try again in ${nextMonthName}, which will begin ${nextMonthDelta}
					`
				};
			}
			else if (response.statusCode === 429 || response.statusCode >= 500) {
				return {
					success: false,
					reply: `The ChatGPT service is likely overloaded at the moment! Please try again later.`
				};
			}
			else {
				const idString = (logID) ? `Mention this ID: Log-${logID}` : "";
				return {
					success: false,
					reply: `Something went wrong with the ChatGPT service! Please let @Supinic know. ${idString}`
				};
			}
		}

		const { choices, usage } = response.body;
		await GptCache.addUsageRecord(context.user, usage.total_tokens, modelName);

		const [chatResponse] = choices;
		const text = chatResponse.text.trim();
		const moderationCheck = await sb.Got("GenericAPI", {
			method: "POST",
			throwHttpErrors: false,
			url: `https://api.openai.com/v1/moderations`,
			headers: {
				Authorization: `Bearer ${sb.Config.get("API_OPENAI_KEY")}`
			},
			json: {
				input: text
			}
		});

		if (!moderationCheck.ok || !Array.isArray(moderationCheck.body.results)) {
			const logId = await sb.Logger.log(
				"Command.Warning",
				`GPT moderation failed! ${JSON.stringify({ body: moderationCheck.body })}`,
				context.channel,
				context.user
			);

			return {
				success: false,
				reply: `Could not check your response for moderation! Please try again later. Reference ID: ${logId}`
			};
		}

		const [moderationResult] = moderationCheck.body.results;
		const { categories, category_scores: scores } = moderationResult;
		if (categories.hate || categories["violence/graphic"] || categories["sexual/minors"]) {
			const logId = await sb.Logger.log(
				"Command.Warning",
				`Unsafe GPT content generated! ${JSON.stringify({ text, scores })}`,
				context.channel,
				context.user
			);

			return {
				success: false,
				reply: `Unsafe content generated! Reference ID: ${logId}`
			};
		}

		const reply = chatResponse.text.trim();
		if (context.params.history) {
			await GptHistory.add(context.user, {
				prompt: query,
				response: reply,
				temperature
			});
		}

		return {
			reply: `🤖 ${reply}`
		};
	}),
	Dynamic_Description: (async (prefix) => {
		const ChatGptConfig = require("./config.json");
		const [defaultModelName, defaultModelData] = Object.entries(ChatGptConfig.models).find(i => i[1].default === true);
		const { regular, subscriber } = ChatGptConfig.userTokenLimits;
		const { outputLimit } = ChatGptConfig;
		const basePriceModel = "Davinci";

		const modelListHTML = Object.entries(ChatGptConfig.models).map(([name, modelData]) => {
			const letter = name[0].toUpperCase();
			const capName = sb.Utils.capitalize(name);
			const defaultString = (modelData === defaultModelData)
				? " (default model)"
				: "";

			if (modelData.disabled) {
				return `<li><del><b>${capName}</b> (${letter})</del> - model is currently disabled: ${modelData.disableReason ?? "(N/A)"}</li>`;
			}
			else if (modelData.usageDivisor === 1) {
				return `<li><b>${capName}</b> (${letter}) ${defaultString}</li>`;
			}
			else {
				return `<li><b>${capName}</b> (${letter}) - ${modelData.usageDivisor}x cheaper than ${basePriceModel}${defaultString}</li>`;
			}
		}).join("");

		return [
			"Ask ChatGPT pretty much anything, and watch technology respond to you in various fun and interesting ways!",
			`Powered by <a href="https://openai.com/blog/chatgpt/">OpenAI's ChatGPT</a> using the <a href="https://en.wikipedia.org/wiki/GPT-3">GPT-3 language model</a>.`,
			"",

			"<h5>Limits</h5>",
			`ChatGPT works with "tokens". You have a specific amount of tokens you can use per hour and per day (24 hours).`,
			"If you exceed this limit, you will not be able to use the command until an hour (or a day) passes since your last command execution",
			`One hundred "tokens" vaguely correspond to about ~75 words, or about one paragraph, or one full Twitch message.`,
			"",

			"Both your input and output tokens will be tracked.",
			`You can check your current token usage with the <a href="/bot/command/detail/check">${prefix}check gpt</a> command.`,
			`If you would like to use the command more often and extend your limits, consider <a href="https://www.twitch.tv/products/supinic">subscribing</a> to me (@Supinic) on Twitch for extended limits! All support is appreciated!`,
			"",

			`Regular limits: ${regular.hourly} tokens per hour, ${regular.daily} tokens per day.`,
			`Subscriber limits: ${subscriber.hourly} tokens per hour, ${subscriber.daily} tokens per day.`,
			"",

			"<h5>Models</h5>",
			"There are four models you can choose from:",
			`<ul>${modelListHTML}</ul>`,

			"Each next model in succession is more powerful and more coherent than the previous, but also more expensive to use.",
			"When experimenting, consider using one of the lower tier models, only then moving up to higher tiers!",
			"For example: 100 tokens used in Davinci → 100 tokens used from your limit,",
			"but: 100 tokens used in Babbage (which is 40x cheaper) → 2.5 tokens used from your limit.",
			"",

			`You can also check out the <a href="https://beta.openai.com/docs/models/feature-specific-models">official documentation</a> of GPT-3 models on the official site for full info.`,
			"",

			"<h5>Basic usage</h5>",
			`<code>${prefix}gpt (your query)</code>`,
			`<code>${prefix}gpt What should I eat today?</code>`,
			"Queries ChatGPT for whatever you ask or tell it.",
			`This uses the <code>${sb.Utils.capitalize(defaultModelName)}</code> model by default.`,
			"",

			`<code>${prefix}gpt model:(name) (your query)</code>`,
			`<code>${prefix}gpt model:curie What should I name my goldfish?</code>`,
			"Queries ChatGPT with your selected model.",
			"",

			"<h5>Temperature</h5>",
			`<code>${prefix}gpt temperature:(numeric value) (your query)</code>`,
			`<code>${prefix}gpt temperature:0.5 What should I eat today?</code>`,
			`Queries ChatGPT with a specified "temperature" parameter.`,
			`Temperature is more-or-less understood to be "wildness" or "creativity" of the input.`,
			"The lower the value, the more predictable, but factual the response is.",
			"The higher the value, the more creative, unpredictable and wild the response becomes.",
			`By default, the temperature value is <code>${ChatGptConfig.defaultTemperature}</code>.`,
			"",

			"<b>Important:</b> Only temperature values between 0.0 and 1.0 are guaranteed to give you proper replies.",
			"The command however supports temperature values all the way up to 2.0 - where you can receive completely garbled responses - which can be fun, but watch out for your token usage!",
			"",

			"<h5>History</h5>",
			`<code>${prefix}gpt history:true (your query)</code>`,
			`<code>${prefix}gpt temperature:0.5 What should I eat today?</code>`,
			`Queries ChatGPT while keeping history of your prompts.`,
			`This allows you to keep some sort of a "session" with ChatGPT.`,
			"The history will track the responses and allow the use of any model until the model's input limit is exceeded.",
			"You can always downgrade the model to receive more data, even if a higher model refuses to work with that muich data.",
			"",

			"Your history is kept for 7 days or until you delete it yourself.",
			`To delete your history, use the <a href="/bot/command/detail/set">$unset gpt-history</a> command.`,
			`To export your history, use the <a href="/bot/command/detail/check">$check gpt-history</a> command.`,
			"",

			"<h5>Other</h5>",
			`<code>${prefix}gpt limit:(numeric value) (your query)</code>`,
			`<code>${prefix}gpt limit:25 (your query)</code>`,
			`Queries ChatGPT with a maximum limit on the response tokens.`,
			"By using this parameter, you can limit the response of ChatGPT to possibly preserve your usage tokens.",
			`The default token limit is ${outputLimit.default}, and you can specify a value between 1 and ${outputLimit.maximum}.`,
			"",

			"<b>Warning!</b> This limit only applies to ChatGPT's <b>output</b>! You must control the length of your input query yourself."
		];
	})
};
