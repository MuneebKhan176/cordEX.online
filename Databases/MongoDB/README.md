# CORDEX MongoDB schema

`Social_Platform/social_models.js` remains the source of truth for the MongoDB schemas and indexes. Do not duplicate its model definitions in this directory.

Run `node Databases/MongoDB/initMongoDB.js` with the application's `MONGO_URI`. The initializer loads the existing model exports and calls `Model.init()` for each exported Mongoose model. Mongoose creates missing collections and ensures the schema-declared indexes.

The initializer does not drop collections or delete documents. If an existing index conflicts with a changed schema definition, initialization fails visibly; review and migrate that index deliberately rather than automatically dropping production indexes.
