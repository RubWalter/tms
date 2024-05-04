# Use the official Node.js Alpine image with Node.js version 21
FROM node:21-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Expose the port the app runs on
EXPOSE 9999

# Command to run the application
CMD ["node", "index.js"]
