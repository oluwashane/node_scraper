const { Client } = require('@googlemaps/google-maps-services-js');

const client = new Client({});

async function searchGoogleBusiness(businessName, address) {
  try {
    // First, search for the business
    const searchResponse = await client.findPlaceFromText({
      params: {
        input: `${businessName} ${address}`,
        inputtype: 'textquery',
        key: process.env.GOOGLE_MAPS_API_KEY,
        fields: ['place_id', 'formatted_address', 'name']
      }
    });

    if (!searchResponse.data.candidates?.length) {
      return { error: 'Business not found on Google' };
    }

    // Get detailed place information
    const placeId = searchResponse.data.candidates[0].place_id;
    const detailsResponse = await client.placeDetails({
      params: {
        place_id: placeId,
        key: process.env.GOOGLE_MAPS_API_KEY,
        fields: [
          'name',
          'formatted_address',
          'formatted_phone_number',
          'international_phone_number',
          'website',
          'opening_hours',
          'rating',
          'user_ratings_total',
          'business_status'
        ]
      }
    });

    const place = detailsResponse.data.result;
    
    return {
      name: place.name,
      address: place.formatted_address,
      phone: place.formatted_phone_number || place.international_phone_number,
      website: place.website,
      rating: place.rating,
      totalRatings: place.user_ratings_total,
      status: place.business_status,
      openingHours: place.opening_hours?.weekday_text
    };
  } catch (error) {
    console.error('Google Places API error:', error);
    return { error: error.message };
  }
}

module.exports = { searchGoogleBusiness }; 