package com.growthtracker.app.util

import kotlinx.serialization.json.Json
import retrofit2.HttpException

/**
 * Utility to parse error messages from API responses
 */
object ErrorUtils {
    
    private val json = Json { 
        ignoreUnknownKeys = true 
        isLenient = true
    }

    fun parseError(exception: Exception): String {
        return when (exception) {
            is HttpException -> {
                try {
                    val errorBody = exception.response()?.errorBody()?.string()
                    if (errorBody != null) {
                        parseErrorBody(errorBody)
                    } else {
                        getHttpErrorMessage(exception.code())
                    }
                } catch (e: Exception) {
                    getHttpErrorMessage(exception.code())
                }
            }
            else -> exception.message ?: "An unexpected error occurred"
        }
    }

    private fun parseErrorBody(errorBody: String): String {
        return try {
            // Try to parse as JSON with "error" field
            val jsonElement = json.parseToJsonElement(errorBody)
            val jsonObject = jsonElement as? kotlinx.serialization.json.JsonObject
            
            // Look for common error field names
            val errorMessage = jsonObject?.get("error")?.toString()?.removeSurrounding("\"")
                ?: jsonObject?.get("message")?.toString()?.removeSurrounding("\"")
                ?: jsonObject?.get("detail")?.toString()?.removeSurrounding("\"")
            
            errorMessage ?: errorBody
        } catch (e: Exception) {
            errorBody
        }
    }

    private fun getHttpErrorMessage(code: Int): String {
        return when (code) {
            400 -> "Invalid request"
            401 -> "Session expired. Please login again"
            403 -> "Access denied"
            404 -> "Not found"
            409 -> "Conflict - Resource already exists"
            422 -> "Validation error"
            429 -> "Too many requests. Please try again later"
            500 -> "Server error. Please try again later"
            502 -> "Server is temporarily unavailable"
            503 -> "Service unavailable"
            else -> "Something went wrong (Error $code)"
        }
    }
}
