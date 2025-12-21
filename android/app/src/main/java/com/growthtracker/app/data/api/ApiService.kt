package com.growthtracker.app.data.api

import com.growthtracker.app.data.model.*
import retrofit2.http.*

interface ApiService {
    @POST("register")
    suspend fun register(@Body request: RegisterRequest): AuthResponse

    @POST("login")
    suspend fun login(@Body request: LoginRequest): AuthResponse

    @POST("create-activity")
    suspend fun createActivity(
        @Header("Authorization") token: String,
        @Body request: CreateActivityRequest
    ): ActivityResponse

    @POST("get-activities")
    suspend fun getActivities(
        @Header("Authorization") token: String,
        @Body request: GetActivitiesRequest
    ): ActivityResponse

    @POST("get-streak")
    suspend fun getStreak(
        @Header("Authorization") token: String,
        @Body request: GetStreakRequest
    ): StreakResponse

    @POST("users")
    suspend fun searchUsers(
        @Header("Authorization") token: String,
        @Body request: GetUsersRequest
    ): GetUsersResponse
}
