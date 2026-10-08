import React from 'react';
import {Composition} from 'remotion';
import {ShedTour, TOUR_FRAMES} from './shed-tour';

export const Root: React.FC = () => (
  <Composition id="ShedTour" component={ShedTour} durationInFrames={TOUR_FRAMES} fps={30} width={1920} height={1080} />
);
