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
//Application setup
//--------------------------------
const PORT = process.env.PORT || 3000;
const app = express();
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
  const SQL = `SELECT * FROM ${handler.tableName} WHERE location_id=$1`;

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
}

function Events(data) {
  let time = Date.parse(data.start.local);
  let newDate = new Date(time).toDateString();
  this.link = data.url;
  this.name = data.name.text;
  this.event_date = newDate;
  this.summary = data.summary;
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

Weather.prototype.save = function(id){
  let SQL = `INSERT INTO weathers 
    (forecast, time, location_id)
    VALUES ($1, $2, $3)
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

Events.prototype.save = function(id){
  let SQL = `INSERT INTO events 
    (link, event_name, event_date, summary, location_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id;`;

  let values = Object.values(this);
  values.push(id);

  return client.query(SQL, values);
};

Events.fetch = (location) => {
  console.log('here in event fetch');
  // console.log(request.query.data.formatted_query);
  // console.log(location);
  const url = `https://www.eventbriteapi.com/v3/events/search?token=${process.env.EVENTBRITE_API_KEY}&location.address=${location.formatted_query}`;
  return superagent.get(url)
    .then(result => {
      // console.log(result.body.events.data);
      const eventSummaries = result.body.events.map(event => {
        const summary = new Events(event);
        summary.save(location.id);
        return summary;
      });
      return eventSummaries;
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
        .then(results => response.send(results));
    }
  };
  Location.lookup(locationHandler);
};

let getWeather = (request, response) => {
  // console.log(request.query.data);
  const weatherHandler = {
    location: request.query.data,
    tableName: Weather.tableName,
    cacheHit: results => {
      console.log('Got the data Weather');
      response.send(results[0]);
    },
    cacheMiss: () => {
      console.log('Fetching Weather');
      Weather.fetch(request.query.data)
        .then(results => response.send(results));
    }
  };
  Weather.lookup(weatherHandler);
};

let getEvents = (request, response) => {
  const eventHandler = {
    location: request.query.data,
    tableName: Events.tableName,
    cacheHit: results => {
      console.log('Got the data Events');
      response.send(results[0]);
    },
    cacheMiss: () => {
      console.log('Fetching Event');
      // console.log(request.query.data);
      Events.fetch(request.query.data)
        .then(results => response.send(results));
    }
  };
  Events.lookup(eventHandler);
};


//   let url = `https://www.eventbriteapi.com/v3/events/search?token=${process.env.EVENTBRITE_API_KEY}&location.address=${request.query.data.formatted_query}`;

//   return superagent.get(url)
//     .then(result => {
//       const eventData = result.body.events.map(event => {
//         return new Events(event);
//       });

//       response.send(eventData);
//     })
//     .catch(() => errorMessage());
// };

//--------------------------------
// Routes
//--------------------------------
app.get('/location', searchCoords);
app.get('/weather', getWeather);
app.get('/events', getEvents);


//--------------------------------
// Power On
//--------------------------------
app.listen(PORT, () => console.log(`app is listening ${PORT}`));