'use strict';

//--------------------------------
// Load Enviroment Variables from the .env file
//--------------------------------
require('dotenv').config();

//--------------------------------
//--------------------------------
const express = require('express');
const cors = require('cors');
const superagent = require('superagent');
const pg = require('pg');

//--------------------------------
// Get cors to work
// https://stackoverflow.com/questions/11001817/allow-cors-rest-request-to-a-express-node-js-application-on-heroku
//--------------------------------
const allowCrossDomain = function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');

  // intercept OPTIONS method
  if ('OPTIONS' == req.method) {
    res.send(200);
  }
  else {
    next();
  }
};

//--------------------------------
//Application setup
//--------------------------------
const PORT = process.env.PORT || 3000;
const app = express();
app.use(allowCrossDomain);
app.use(cors());

//--------------------------------
// Database Config
//--------------------------------

// 1. Create a client with connection url
const client = new pg.Client(process.env.DATABASE_URL);

// 2. Connect client
client.connect();

// 3. Add event listeners
client.on('err', err => console.error(err));

//--------------------------------
// Error Message
//--------------------------------
let errorMessage = () => {
  let errorObj = {
    status: 500,
    responseText: 'Sorry something went wrong',
  };
  console.log(errorObj);
  return errorObj;
};

//--------------------------------
// Helper functions
//--------------------------------
let lookup = (handler) => {
  const SQL = `SELECT * FROM ${handler.tableName} WHERE location_id=$1;`;

  return client.query(SQL, [handler.location.id])
    .then(result => {
      if(result.rowCount > 0){
        handler.cacheHit(result);
      }else{
        handler.cacheMiss();
      }
    })
    .catch(errorMessage);
};

let deleteByLocationId = (table, location_id) => {
  const SQL = `DELETE FROM ${table} WHERE location_id=${location_id}`;

  return client.query(SQL);
};

const timeouts = {
  weather: 15 * 1000,  // 15 seconds per request
  events: 60 * 60 * 1000, // hourly update for latest events but not too frequent
  movies: 60 * 60 * 24 * 1000, // daily movie updates for latest movies but not too frequent
  yelp: 60 * 60 * 4 * 1000 // update every four hours for latest reviews but not too frequent
};

//--------------------------------
// Constructors Functions
//--------------------------------
function Location(query, geoData) {
  this.search_query = query;
  this.formatted_query = geoData.formatted_address;
  this.latitude = geoData.geometry.location.lat;
  this.longitude = geoData.geometry.location.lng;
}

function Weather(day) {
  this.forecast = day.summary;
  this.time = new Date(day.time * 1000).toDateString();
  this.created_at = Date.now();
}

function Events(data) {
  let time = Date.parse(data.start.local);
  let newDate = new Date(time).toDateString();
  this.link = data.url;
  this.name = data.name.text;
  this.event_date = newDate;
  this.summary = data.summary;
  this.created_at = Date.now();
}

function Movies(data) {
  this.title = data.title;
  this.released_on = data.release_date;
  this.total_votes = data.vote_count;
  this.average_votes = data.vote_average;
  this.popularity = data.popularity;
  this.overview = data.overview;
  this.image_url = `https://image.tmdb.org/t/p/original${data.poster_path}`;
  this.created_at = Date.now();
}

function Yelp(data) {
  this.name = data.name;
  this.rating = data.rating;
  this.price = data.price;
  this.url = data.url;
  this.image_url = data.image_url;
  this.created_at = Date.now();
}

//--------------------------------
// Location
//--------------------------------

//Static function
Location.lookup = handler => {
  const SQL = `SELECT * FROM locations WHERE search_query=$1;`;
  const values = [handler.query];

  return client.query(SQL, values)
    .then(results => {
      if(results.rowCount > 0){
        handler.cacheHit(results);
      }else{
        handler.cacheMiss(results);
      }
    })
    .catch(console.error);
};

Location.fetchLocation = (query) => {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GEOCODE_API_KEY}`;

  return superagent.get(url)
    .then(result => {
      if(!result.body.results.length) throw 'No data';
      let location = new Location(query, result.body.results[0]);
      return location.save()
        .then(result => {
          location.id = result.rows[0].id;
          return location;
        });
    });
};

Location.prototype.save = function(){
  let SQL = `INSERT INTO locations 
    (search_query, formatted_query, latitude, longitude)
    VALUES ($1, $2, $3, $4)
    RETURNING id;`;

  let values = Object.values(this);

  return client.query(SQL, values);
};

//--------------------------------
// Weather
//--------------------------------
Weather.tableName = 'weathers';
Weather.lookup = lookup;
Weather.deleteByLocationId = deleteByLocationId;

Weather.prototype.save = function(id){
  let SQL = `INSERT INTO weathers 
    (forecast, time, created_at, location_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id;`;

  let values = Object.values(this);
  values.push(id);

  return client.query(SQL, values);
};

Weather.fetch = (location) => {

  const url = `https://api.darksky.net/forecast/${process.env.WEATHER_API_KEY}/${location.latitude},${location.longitude}`;

  return superagent.get(url)
    .then(result => {
      const weatherSummaries = result.body.daily.data.map(day => {
        const summary = new Weather(day);
        summary.save(location.id);
        return summary;
      });
      return weatherSummaries;
    });
};


//--------------------------------
// Events
//--------------------------------
Events.tableName = 'events';
Events.lookup = lookup;
Events.deleteByLocationId = deleteByLocationId;

Events.prototype.save = function(id){
  let SQL = `INSERT INTO events 
    (link, name, event_date, summary, created_at, location_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id;`;

  let values = Object.values(this);
  values.push(id);

  return client.query(SQL, values);
};

Events.fetch = (location) => {
  console.log('here in event fetch');
  const url = `https://www.eventbriteapi.com/v3/events/search?token=${process.env.EVENTBRITE_API_KEY}&location.address=${location.formatted_query}`;
  return superagent.get(url)
    .then(result => {
      const eventSummaries = result.body.events.map(event => {
        const summary = new Events(event);
        summary.save(location.id);
        return summary;
      });
      return eventSummaries;
    });
};

//--------------------------------
// Movie
//--------------------------------

Movies.tableName = 'movies';
Movies.lookup = lookup;
Movies.deleteByLocationId = deleteByLocationId;

Movies.prototype.save = function(id){
  let SQL = `INSERT INTO movies 
    (title, released_on, total_votes, average_votes, popularity, overview, image_url, created_at, location_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id;`;

  let values = Object.values(this);
  values.push(id);

  return client.query(SQL, values);
};

Movies.fetch = (location) => {
  console.log('here in movie fetch');

  const url = `https://api.themoviedb.org/3/movie/now_playing?api_key=${process.env.MOVIE_API_KEY}&language=en-US&page=1`;

  return superagent.get(url)
    .then(result => {

      const movieSummaries = result.body.results.map(movie => {
        const summary = new Movies(movie);
        summary.save(location.id);
        return summary;
      });
      return movieSummaries;
    })
    .catch(error => {
      console.log(error);
    });
};

//--------------------------------
// Yelp
//--------------------------------
Yelp.tableName = 'yelps';
Yelp.lookup = lookup;
Yelp.deleteByLocationId = deleteByLocationId;

Yelp.prototype.save = function(id){
  let SQL = `INSERT INTO yelps 
    (name, rating, price, url, image_url, created_at, location_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id;`;

  let values = Object.values(this);
  values.push(id);

  return client.query(SQL, values);
};

Yelp.fetch = (location) => {
  console.log('here in yelp');

  const url = `https://api.yelp.com/v3/businesses/search?location=${location.search_query}`;

  return superagent.get(url)
    .set('Authorization', `Bearer ${process.env.YELP_API_KEY}`)
    .then(result => {
      const yelpSummaries = result.body.businesses.map(review => {
        const summary = new Yelp(review);
        summary.save(location.id);
        return summary;
      });
      return yelpSummaries;
    })
    .catch(error => {
      console.log(error);
    });
};
//--------------------------------
// Route Callbacks
//--------------------------------
let searchCoords = (request, response) => {
  const locationHandler = {
    query: request.query.data,
    cacheHit: results => {
      console.log('Got the data Locations');
      response.send(results.rows[0]);
    },
    cacheMiss: () => {
      console.log('Fetching Locations');
      Location.fetchLocation(request.query.data)
        .then(results => response.send(results))
        .catch(console.error);
    }
  };
  Location.lookup(locationHandler);
};

let getWeather = (request, response) => {
  const weatherHandler = {
    location: request.query.data,
    tableName: Weather.tableName,
    cacheHit: function(result){
      let ageOfResults = (Date.now() - result.rows[0].created_at);
      if(ageOfResults > timeouts.weather){
        console.log('weather cache was invalid');
        Weather.deleteByLocationId(Weather.tableName, request.query.data.id);
        this.cacheMiss;
      }else{
        console.log('weather cache was valid');
        response.send(result.rows);
      }

    },
    cacheMiss: () => {
      console.log('Fetching Weather');
      Weather.fetch(request.query.data)
        .then(results => response.send(results))
        .catch(console.error);
    }
  };
  Weather.lookup(weatherHandler);
};

let getEvents = (request, response) => {
  const eventHandler = {
    location: request.query.data,
    tableName: Events.tableName,
    cacheHit: function(result){
      let ageOfResults = (Date.now() - result.rows[0].created_at);
      if(ageOfResults > timeouts.events){
        console.log('events cache was invalid');
        Events.deleteByLocationId(Events.tableName, request.query.data.id);
        this.cacheMiss;
      }else{
        console.log('events cache was valid');
        response.send(result.rows);
      }
    },
    cacheMiss: () => {
      console.log('Fetching Event');

      Events.fetch(request.query.data)
        .then(results => response.send(results))
        .catch(console.error);
    }
  };
  Events.lookup(eventHandler);
};

let getMovies = (request, response) => {
  const eventHandler = {
    location: request.query.data,
    tableName: Movies.tableName,
    cacheHit: function(result){
      let ageOfResults = (Date.now() - result.rows[0].created_at);
      if(ageOfResults > timeouts.movies){
        console.log('movies cache was invalid');
        Movies.deleteByLocationId(Movies.tableName, request.query.data.id);
        this.cacheMiss;
      }else{
        console.log('movies cache was valid');
        response.send(result.rows);
      }
    },
    cacheMiss: () => {
      console.log('Fetching Movies');
      Movies.fetch(request.query.data)
        .then(results => response.send(results))
        .catch(console.error);
    }
  };
  Movies.lookup(eventHandler);
};

let getYelp = (request, response) => {
  const eventHandler = {
    location: request.query.data,
    tableName: Yelp.tableName,
    cacheHit: function(result){
      let ageOfResults = (Date.now() - result.rows[0].created_at);
      if(ageOfResults > timeouts.yelp){
        console.log('yelp cache was invalid');
        Yelp.deleteByLocationId(Yelp.tableName, request.query.data.id);
        this.cacheMiss;
      }else{
        console.log('yelp cache was valid');
        response.send(result.rows);
      }
    },
    cacheMiss: () => {
      console.log('Fetching Yelp');
      Yelp.fetch(request.query.data)
        .then(results => response.send(results))
        .catch(console.error);
    }
  };
  Yelp.lookup(eventHandler);
};

//--------------------------------
// Routes
//--------------------------------
app.get('/location', searchCoords);
app.get('/weather', getWeather);
app.get('/events', getEvents);
app.get('/movies', getMovies);
app.get('/yelp', getYelp);


//--------------------------------
// Power On
//--------------------------------
app.listen(PORT, () => console.log(`app is listening ${PORT}`));
