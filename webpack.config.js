const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  // Set the mode dynamically based on the environment; defaults to 'development'.
  mode: process.env.NODE_ENV || 'development',

  // Target a Node.js environment.
  target: 'node',

  // Use source maps for better debugging in development.
  devtool: process.env.NODE_ENV === 'production' ? 'source-map' : 'inline-source-map',

  // Specify the entry point for the application.
  entry: './src/main.js',

  // Define the output configuration.
  output: {
    filename: '[name].js', // Use dynamic chunk names.
    path: path.resolve(__dirname, 'build'), // Specify output directory.
    clean: true, // Clean the output directory before every build.
    library: {
      type: 'commonjs2', // CommonJS output for compatibility with Node.js
    },
  },

  // Define module rules for processing files.
  module: {
    rules: [
      {
        test: /\.js$/, // Match JavaScript files.
        exclude: /node_modules/, // Exclude dependencies.
        use: 'babel-loader', // Use Babel loader for transpilation.
      },
    ],
  },

  // Define optimization settings.
  optimization: {
    minimize: process.env.NODE_ENV === 'production', // Minimize only in production mode.
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          format: {
            comments: false, // Remove comments from output.
          },
        },
        extractComments: false, // Do not extract comments into separate files.
      }),
    ],
  },

  // Resolve extensions for better import statements.
  resolve: {
    extensions: ['.js'], // Allow imports without specifying extensions.
  },

  /**
   * Disable Webpack processing of `__dirname` and `__filename`.
   * Allows Node.js to use the native values.
   * https://github.com/webpack/webpack/issues/2010
   */
  node: {
    __dirname: false,
    __filename: false,
  },
};
