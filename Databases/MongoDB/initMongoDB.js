const mongoose = require("mongoose");
const path = require("node:path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

async function initMongoDB() {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("Missing required environment variable: MONGO_URI");

    await mongoose.connect(uri);

    try {
        const models = require("./social_models");
        const registeredModels = Object.values(models)
            .filter(value => value && value.modelName && typeof value.init === "function");

        if (registeredModels.length === 0) {
            throw new Error("No Mongoose models were exported from Social_Platform/social_models.js");
        }

        for (const model of registeredModels) {
            await model.init();
            console.log(`MongoDB collection and indexes ready: ${model.collection.name}`);
        }

        console.log(`MongoDB schema initialization completed for ${registeredModels.length} models.`);
    } finally {
        await mongoose.disconnect();
    }
}

initMongoDB().catch(error => {
    console.error("MongoDB schema initialization failed:", error);
    process.exitCode = 1;
});
