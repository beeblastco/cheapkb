The current project name is `cheapkb`. Focus on cheap solution for RAG, priority features and engineering way to make it cheaps, trade off with latency and critical speed (S3 Vector, Lambda batch, SQS, DynamoDB), all covered by the free tier.

IaC using sst. The project is deployed on AWS with account id that start with 95 and end with 09. Always check what is the current aws profile, account id before you do anything.

Set AWS_PROFILE=95...09 before you interact with the aws cli.

The .env file is used to store the environment variables. The sst.config.ts will load the env variables from the .env file.

The README.md contains the documentation, instructions and architecture of the project. Update when you changed anything, prevent stale.

Do not use dash comments, banner comments, separate comments in the code.

Write simple code, priority duplicate code for readability, no abstraction, no custom type, interface when can use library, dependancy.

functions folder hold all the lambda functions logic. Each folder inside represent a separate function. Do not create config.ts file for share configuration, use the sst.config.ts file as a configuration file. Use types.ts file for shared types between functions and utils.ts file for shared small logics between functions.

Naming convention AWS Services: <project>-<service_name>-<account_id>-<region>. If we deployed with staging then it will be: <project>-<staging>-<service_name>-<account_id>-<region>

Put all defined const, types, interface at the beginning of the scripts. Next should be the export or main logic of the script. At the bottom of the scripts should be private, internal functions that use inisde the file. All the functions types should be group together or place next together, for example: all async functions should be placed in a rows, next will be all function, etc... Follow strictly this structure behaviour when writing, edit or delete code. Only add comments into key sections, keep comments max 2 lines with clear explaination.

Always check for lint, typescript errors and warnings. Use prettier to format the code.
