/**
 * API Integration Hub
 * @module api-integration
 * @description This module provides a central hub for API integrations
 * @author [Your Name]
 */
import axios from 'axios';
import OpenClawAPI from 'openclaw-api'; // Import OpenClaw API Integrator

/**
 * API Integration Hub class
 * @class ApiIntegrationHub
 * @description This class provides methods for making API requests
 */
class ApiIntegrationHub {
  /**
   * Constructor for the API Integration Hub
   * @param {string} url - The base URL for the API
   */
  constructor(url) {
    this.url = url;
  }

  /**
   * Make a GET request to the API
   * @param {string} path - The path to the API endpoint
   * @returns {Promise} A promise that resolves to the response data
   */
  async get(path) {
    try {
      const response = await axios.get(`${this.url}/${path}`);
      return response.data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Make a POST request to the API
   * @param {string} path - The path to the API endpoint
   * @param {object} data - The data to be sent in the request body
   * @returns {Promise} A promise that resolves to the response data
   */
  async post(path, data) {
    try {
      const response = await axios.post(`${this.url}/${path}`, data);
      return response.data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Returns an instance of the API Integration Manager
   * @returns {ApiIntegrationManager} An instance of the API Integration Manager
   */
  getManager() {
    return new ApiIntegrationManager(this.url);
  }
}

// Export the API Integration Hub class
export default ApiIntegrationHub;

/**
 * API Integration Manager class
 * @class ApiIntegrationManager
 * @description This class provides methods for managing API instances
 */
class ApiIntegrationManager {
  /**
   * Constructor for the API Integration Manager
   * @param {string} url - The base URL for the API
   */
  constructor(url) {
    this.url = url;
  }

  /**
   * Switches to a new API instance
   * @param {string} url - The new base URL for the API
   */
  switchUrl(url) {
    this.url = url;
  }

  /**
   * Makes a GET request to the API using the current instance
   * @param {string} path - The path to the API endpoint
   * @returns {Promise} A promise that resolves to the response data
   */
  async get(path) {
    try {
      const response = await axios.get(`${this.url}/${path}`);
      return response.data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Makes a POST request to the API using the current instance
   * @param {string} path - The path to the API endpoint
   * @param {object} data - The data to be sent in the request body
   * @returns {Promise} A promise that resolves to the response data
   */
  async post(path, data) {
    try {
      const response = await axios.post(`${this.url}/${path}`, data);
      return response.data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Makes a PUT request to the API using the current instance
   * @param {string} path - The path to the API endpoint
   * @param {object} data - The data to be sent in the request body
   * @returns {Promise} A promise that resolves to the response data
   */
  async put(path, data) {
    try {
      const response = await axios.put(`${this.url}/${path}`, data);
      return response.data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  /**
   * Integrates an API using the OpenClaw API Integrator
   * @param {string} api - The API to integrate
   * @param {object} config - The configuration options for the API
   */
  async integrateApi(api, config) {
    const openClawApi = new OpenClawAPI(api, config);
    return openClawApi;
  }
}