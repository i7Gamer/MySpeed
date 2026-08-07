import express from 'express';
import passwordWrapper from '../middlewares/passwordWrapper.js';
import generateOpenGraphImage from '../controller/opengraph.js';

const app = express.Router();

const BANNER_URL = 'https://repository-images.githubusercontent.com/478222232/b5331514-aa27-4a56-af3e-c4b25446438d';

app.get("/image", passwordWrapper(true, (req, res) => {
  // If there is a password set and the user does not want others to view their test data, return the project banner
  res.redirect(BANNER_URL);
}), async (req, res) => {

  try {
    const png = await generateOpenGraphImage();

    if (!png) {
      return res.redirect(BANNER_URL);
    }

    res.setHeader("Content-Type", "image/png").status(200).send(png);
  } catch (error) {
    console.error(`Could not generate the OpenGraph image: ${error.message}`);
    res.redirect(BANNER_URL);
  }
});

export default app;
