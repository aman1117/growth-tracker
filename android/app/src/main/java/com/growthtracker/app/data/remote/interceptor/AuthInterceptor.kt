package com.growthtracker.app.data.remote.interceptor

import com.growthtracker.app.data.local.TokenManager
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject

class AuthInterceptor @Inject constructor(
    private val tokenManager: TokenManager
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val token = runBlocking { tokenManager.accessToken.first() }
        
        val request = chain.request().newBuilder().apply {
            if (!token.isNullOrBlank()) {
                addHeader("Authorization", "Bearer $token")
            }
            addHeader("Content-Type", "application/json")
        }.build()
        
        val response = chain.proceed(request)
        
        // Handle 401 Unauthorized - clear token
        if (response.code == 401) {
            runBlocking { tokenManager.clearAll() }
        }
        
        return response
    }
}
