# **Product Plan: Tap Story \- Collaborative Social Mode**

## **1\. Vision: The "Living Tree" of Sound**

While the core of Tap Story is a high-performance recorder, its soul is a very specific kind of **Social Tree**.  
At the heart of the structure is a chain of **overlapping duets**: each person records on top of the previous recording and **always leaves a tail** that extends past it, so the next person can duet _that_ tail and then leave a new one of their own. Because any tail could have multiple possible duets, this creates a living tree of linked performances, each branch defined by who chose to pick up which tail. It could be intended as just a back and forth with a friend, or could become a social experiment where multiple paths can be taken (or even mixed).

## **2\. The Core Mechanic: Branching Narratives**

### **2.1 The Data Structure**

The content is organized as a **Directed Acyclic Graph (DAG)**.

- **The Seed:** The root node of the tree.
- **The Node:** Every recording is an immutable entity containing:
  - Audio File (The user's contribution mixed with the parent).
  - Metadata (Relative Speed/Pitch settings).
  - Parent ID (The node this was recorded on top of).
- **The Branch:** When a user records onto an existing node, they do not overwrite it. They create a new **Child Node**.

### **2.2 Visualizing the Tree**

- **The Map (iPad/Mac):** Users can zoom out to see the lineage of a story, visualized like a subway map or evolutionary tree.
- **The Ghost Pills (iPhone):** When listening to a track, alternative branches appear as "Ghost Pills" above or below the active track. Swiping Up/Down seamlessly switches audio to that parallel universe.

### **2.3 The "Canon" (Social Curation)**

With infinite branching, navigation requires curation.

- **Likes \= Gravity:** Users vote on specific nodes.
- **The Canon Path:** When a user presses "Play" on a Seed, the app dynamically calculates the "path of least resistance" (the nodes with the highest cumulative likes) and plays that version as the "Hit Single."
- **Deep Cuts:** Users can manually "Walk the Tree" to explore unpopular, experimental, or weird branches.

## **3\. The "Game" Rules (Interaction Design)**

To prevent chaos and gamify the creation process, Contributors must follow specific constraints.

### **3.1 The "Extension" Rule**

To successfully submit a new branch, the user **must extend the story**.

- **Input:** A user can start listening or monitoring from anywhere in the parent track.
- **Constraint:** The new recording must end _after_ the parent node's end time.
- **Result:** The story physically grows longer with every valid turn.

### **3.2 The "Chain of Duets" Flow**

The recording workflow is automated to encourage flow:

1. **Context:** Player B selects Player A's node.
2. **Auto-Cue:** Recording automatically starts at the _end_ of Player A's audio (or overlaps the tail).
3. **The Handoff:** Player B plays their part.
4. **The Lock:** Once submitted, Player B cannot edit Player A's audio. The past is immutable.

## **4\. Backend Architecture (AWS Serverless)**

To support this massive branching structure without managing servers, we utilize the AWS Mobile Stack.

### **4.1 The Tech Stack**

- **API Gateway:** **AWS AppSync** (GraphQL).
  - _Why:_ GraphQL is ideal for fetching trees (e.g., "Get Node X and all its Children").
- **Database:** **Amazon DynamoDB**.
  - _Pattern:_ Adjacency List (Single Table Design).
  - _Partition Key:_ StoryID.
  - _Sort Key:_ NodeID.
- **Storage:** **Amazon S3**.
- **Processing:** **AWS Lambda** \+ **FFmpeg Layer**.

### **4.2 The "Bounce Down" Strategy**

To keep client performance high, we do not stream 50 separate tracks for a 50-node story.

- **Local Mix:** When recording, the engine mixes the "Parent" \+ "Input".
- **Cloud Bounce:** Upon submission, AWS Lambda processes the audio:
  1. **Decodes** the new input (WAV).
  2. **Mixes** it with the Parent Node's audio.
  3. **Encodes** a new, single stereo file for the Child Node.
- **Result:** The next user only downloads **one file**, preserving bandwidth and battery.

### **4.3 Hybrid Quality Sync**

To ensure the app feels "Instant" (like a social network) but remains "Professional" (like a DAW):

1. **Tier 1 (Fast):** The app uploads a compressed **AAC** version immediately. The node appears on the Global Tree instantly.
2. **Tier 2 (Archival):** In the background (Wi-Fi only), the app uploads the uncompressed **WAV** and the _isolated_ stem.
3. **Future Export:** A user can eventually "Export Project" to download the un-bounced, high-quality stems for mixing in Logic Pro or Ableton.

## **5\. Data Model (DynamoDB Schema)**

**Table: TapStory_Nodes**

| Attribute         | Type   | Description                                  |
| :---------------- | :----- | :------------------------------------------- |
| **PK**            | String | STORY\#\<UUID\> (Groups the whole tree)      |
| **SK**            | String | NODE\#\<UUID\> (Unique ID)                   |
| ParentID          | String | NODE\#\<UUID\> (Pointer to previous node)    |
| AudioURL_Lossy    | String | S3 Link (AAC)                                |
| AudioURL_Lossless | String | S3 Link (WAV)                                |
| RecordedAtRate    | Float  | 1.0, 0.75, etc. (Crucial for Elastic Engine) |
| Duration          | Number | Length in seconds                            |
| Likes             | Number | Counter for "Canon" calculation              |
| AuthorID          | String | User ID                                      |
