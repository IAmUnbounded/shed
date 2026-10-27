import React from 'react';
import {Composition} from 'remotion';
import {ShedTour, TOUR_FRAMES} from './shed-tour';
import {ShedReel, REEL_FRAMES} from './shed-reel';
import {ShedProduct, PRODUCT_FRAMES} from './shed-product';

export const Root: React.FC = () => (
  <>
    <Composition id="ShedTour" component={ShedTour} durationInFrames={TOUR_FRAMES} fps={30} width={1920} height={1080} />
    <Composition id="ShedReel" component={ShedReel} durationInFrames={REEL_FRAMES} fps={30} width={1920} height={1080} />
    <Composition id="ShedProduct" component={ShedProduct} durationInFrames={PRODUCT_FRAMES} fps={30} width={1920} height={1080} />
  </>
);
